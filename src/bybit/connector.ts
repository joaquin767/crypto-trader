// Bybit Connector — ties together REST client, WebSocket client, and adapters.
// Manages connection lifecycle, data flow, and error recovery.

import { randomUUID } from "node:crypto";
import { RestClient } from "./rest.ts";
import { WsClient } from "./ws.ts";
import { BybitConnectionError, BybitFillUncertainError, type BybitConfig, type BybitApiError, type BybitOrderResponse, type BybitPosition, type BybitWalletBalance } from "./types.ts";
import type { MarketSnapshot } from "../market.ts";
import type { TradeResult } from "../executor.ts";
import type { TradeSignal } from "../strategy/signals.ts";
import type { Position } from "../portfolio.ts";
import { tickerToMarketSnapshot, orderResponseToTradeResult, bybitPositionToPosition, bybitSymbolToApp } from "./adapters.ts";
import { logger } from "../logger.ts";
import { recordPendingOrder, clearPendingOrder, getPendingOrders } from "./pending-orders.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BybitConnectorState {
  connected: boolean;
  mode: "paper" | "testnet" | "live";
  latencyMs: number;
  lastTickerTime: number;
  error: string | null;
}

export type TickerHandler = (snapshots: Map<string, MarketSnapshot>) => void;
export type TradeHandler = (result: TradeResult) => void;
export type PositionHandler = (positions: Position[]) => void;
/** Unadapted position data — carries leverage/liquidationPrice, which the
 *  app's Position type doesn't (see onRawPosition). */
export type RawPositionHandler = (positions: BybitPosition[]) => void;
export type ConnectionHandler = (state: BybitConnectorState) => void;

export class BybitConnector {
  public config: BybitConfig;
  public rest: RestClient;
  public wsPublic: WsClient;
  public wsPrivate: WsClient;

  private tickerHandlers = new Set<TickerHandler>();
  private tradeHandlers = new Set<TradeHandler>();
  private positionHandlers = new Set<PositionHandler>();
  private rawPositionHandlers = new Set<RawPositionHandler>();
  private connectionHandlers = new Set<ConnectionHandler>();
  private lastSnapshots = new Map<string, MarketSnapshot>();
  private lotSizeCache = new Map<string, { minQty: string; qtyStep: string }>();
  private tickSizeCache = new Map<string, number>();
  private _state: BybitConnectorState;
  private _connected = false;
  private manuallyDisconnected = false;
  private restPollTimer: ReturnType<typeof setInterval> | null = null;
  private restPollIntervalMs: number;
  private slowReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: BybitConfig) {
    this.config = config;
    this.rest = new RestClient(config);
    this.wsPublic = new WsClient(config, false);
    this.wsPrivate = new WsClient(config, true);
    this.restPollIntervalMs = config.restPollIntervalMs ?? 3000;

    this._state = {
      connected: false,
      mode: config.testnet ? "testnet" : "live",
      latencyMs: 0,
      lastTickerTime: 0,
      error: null,
    };

    // Track real WS status through reconnects (not just the initial connect()),
    // and fall back to REST ticker polling once the public WS gives up retrying.
    // Without this, the dashboard could keep showing "connected" indefinitely
    // after a dropped socket, and the trading loop would keep acting on stale ticks.
    this.wsPublic.setLifecycleHandlers({
      onOpen: () => this.handlePublicWsStatusChange(),
      onClose: () => this.handlePublicWsStatusChange(),
      onReconnectFailed: () => this.handlePublicReconnectExhausted(),
    });
    this.wsPrivate.setLifecycleHandlers({
      onOpen: () => this.notifyConnection(),
      onClose: () => this.notifyConnection(),
    });
  }

  get state(): BybitConnectorState {
    return { ...this._state };
  }

  /** Connect to Bybit: sync time, start WebSocket streams, subscribe to topics. */
  async connect(): Promise<void> {
    this.manuallyDisconnected = false;
    try {
      this._state.error = null;

      // 1. Sync time
      console.log("[bybit] Syncing time...");
      await this.rest.syncTime();
      console.log("[bybit] Time synced.");

      // 2. Connect public WebSocket
      console.log("[bybit] Connecting public WebSocket...");
      await this.wsPublic.connect();
      console.log("[bybit] Public WebSocket connected.");

      // Subscribe to tickers for all symbols
      const tickerTopics = this.config.symbols.map(s => `tickers.${s}`);
      this.wsPublic.subscribe(tickerTopics);

      // Handle ticker data
      for (const topic of tickerTopics) {
        this.wsPublic.on(topic, (topicName: string, data: unknown) => {
          this.handleTicker(topicName, data);
        });
      }

      // 3. Connect private WebSocket (for order confirmations)
      if (this.config.apiKey && this.config.apiSecret) {
        console.log("[bybit] Connecting private WebSocket...");
        await this.wsPrivate.connect();
        console.log("[bybit] Private WebSocket connected.");

        this.wsPrivate.subscribe(["order", "position", "wallet"]);

        this.wsPrivate.on("order", (_topic: string, data: unknown) => {
          this.handleOrder(data);
        });

        this.wsPrivate.on("position", (_topic: string, data: unknown) => {
          this.handlePosition(data);
        });
      }

      this._connected = true;
      this._state.connected = true;
      this._state.mode = this.config.testnet ? "testnet" : "live";
      this.notifyConnection();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._state.error = msg;
      this._connected = false;
      this._state.connected = false;
      this.notifyConnection();
      throw err;
    }
  }

  /** Disconnect from Bybit. */
  disconnect(): void {
    this.manuallyDisconnected = true;
    this.stopRestPolling();
    if (this.slowReconnectTimer) {
      clearTimeout(this.slowReconnectTimer);
      this.slowReconnectTimer = null;
    }
    this.wsPublic.disconnect();
    this.wsPrivate.disconnect();
    this._connected = false;
    this._state.connected = false;
    this._state.error = null;
    this.notifyConnection();
  }

  // ── WebSocket status tracking + REST polling fallback ────────────────
  // WsClient gives up reconnecting after maxReconnectAttempts (exponential backoff,
  // see ws.ts). Per the integration spec (§7 "WebSocket reconnect exhausted"), once
  // that happens we switch to polling REST tickers so the trading loop keeps seeing
  // fresh prices, and we keep trying to restore the socket in the background at a
  // slower, deliberately-conservative cadence (never faster than once per second,
  // per the anti-ban policy).

  private handlePublicWsStatusChange(): void {
    const wasConnected = this._state.connected;
    this._state.connected = this.wsPublic.isConnected();
    if (this._state.connected && !wasConnected) {
      this.stopRestPolling();
    }
    this.notifyConnection();
  }

  private handlePublicReconnectExhausted(): void {
    if (this.manuallyDisconnected) return;
    this.startRestPolling();
    this.scheduleSlowReconnect();
  }

  private scheduleSlowReconnect(delayMs = 30000): void {
    if (this.manuallyDisconnected) return;
    this.slowReconnectTimer = setTimeout(() => {
      if (this.manuallyDisconnected) return;
      this.wsPublic.connect().catch(() => {
        this.scheduleSlowReconnect(delayMs);
      });
    }, delayMs);
  }

  private startRestPolling(): void {
    if (this.restPollTimer) return;
    logger.warn(`[bybit] WebSocket reconnect attempts exhausted — falling back to REST ticker polling every ${this.restPollIntervalMs}ms until it recovers.`);
    this.restPollTimer = setInterval(() => {
      this.pollTickersOnce().catch((err) => {
        console.error("[bybit] REST ticker poll failed:", (err as Error).message);
      });
    }, this.restPollIntervalMs);
  }

  private stopRestPolling(): void {
    if (this.restPollTimer) {
      clearInterval(this.restPollTimer);
      this.restPollTimer = null;
      logger.info("[bybit] WebSocket reconnected — stopping REST ticker polling fallback.");
    }
  }

  private async pollTickersOnce(): Promise<void> {
    const snapshots = new Map<string, MarketSnapshot>();
    for (const bybitSymbol of this.config.symbols) {
      try {
        const res = await this.rest.getTickers("linear", bybitSymbol);
        const list = (res as any).list;
        if (list && list.length > 0) {
          const appSymbol = bybitSymbolToApp(bybitSymbol);
          const previous = this.lastSnapshots.get(appSymbol);
          const snap = tickerToMarketSnapshot(list[0], previous);
          this.lastSnapshots.set(appSymbol, snap);
          snapshots.set(snap.symbol, snap);
        }
      } catch (err) {
        console.warn(`[bybit] REST ticker poll failed for ${bybitSymbol}:`, (err as Error).message);
      }
    }
    if (snapshots.size > 0) {
      this._state.lastTickerTime = Date.now();
      for (const handler of this.tickerHandlers) {
        handler(snapshots);
      }
    }
  }

  /**
   * Reconcile locally-tracked positions against what Bybit actually reports.
   * Call this once after connect() (and optionally periodically) so a crash
   * between an exchange fill and journaling it doesn't leave a real position
   * silently untracked (which would make the bot unable to ever sell it).
   *
   * Per the cash guardrail design, this only ever corrects POSITIONS — cashUsd
   * stays a locally-tracked operating budget and is never derived from the
   * exchange wallet balance.
   *
   * IMPORTANT: a position Bybit reports that isn't in the local journal at all
   * (`unaccountedFor` below) is deliberately NOT added to `merged`. The local
   * cash ledger never paid for it, so if it were merged in, the auto-trading
   * loop could generate a signal that sells it and credit 100% of the
   * proceeds to cashUsd — inflating cash far past maxCapitalUsd from a
   * position the bot never bought with tracked money (this happened in
   * practice: an orphaned 33.1 SOL testnet position got adopted this way and,
   * once sold, pushed cashUsd from ~$97 to ~$3,560 against a $100 operating
   * cap). Surface `unaccountedFor` to the user instead so they can review and
   * close it manually on the exchange.
   */
  async reconcilePositions(localPositions: Position[]): Promise<{ merged: Position[]; unaccountedFor: Position[]; warnings: string[] }> {
    const warnings: string[] = [];
    const unaccountedFor: Position[] = [];
    let exchangePositions: Position[];
    try {
      exchangePositions = (await this.getPositions()).filter(p => Math.abs(p.quantity) > 0);
    } catch (err) {
      warnings.push(`Could not fetch exchange positions for reconciliation: ${(err as Error).message}`);
      return { merged: localPositions, unaccountedFor, warnings };
    }

    const localBySymbol = new Map(localPositions.map(p => [p.symbol, p] as const));
    const exchangeBySymbol = new Map(exchangePositions.map(p => [p.symbol, p] as const));
    const merged: Position[] = [];

    for (const [symbol, exch] of exchangeBySymbol) {
      const local = localBySymbol.get(symbol);
      if (!local) {
        warnings.push(`Bybit reports an open ${symbol} position (qty ${exch.quantity}) that isn't in the local journal. NOT adopting it into auto-trading (the cash ledger never paid for it) — please review and close it manually on Bybit if unexpected.`);
        unaccountedFor.push(exch);
      } else if (Math.abs(local.quantity - exch.quantity) > Math.max(1e-8, exch.quantity * 0.01)) {
        warnings.push(`Position size mismatch for ${symbol}: journal says ${local.quantity}, Bybit says ${exch.quantity} — using Bybit's number.`);
        merged.push({ ...local, quantity: exch.quantity, currentPrice: exch.currentPrice });
      } else {
        merged.push(local);
      }
    }

    for (const [symbol, local] of localBySymbol) {
      if (!exchangeBySymbol.has(symbol)) {
        warnings.push(`Journal believes ${symbol} is open (qty ${local.quantity}) but Bybit reports no such position — the buy may never have filled. Keeping it locally flagged; please verify manually on Bybit.`);
        merged.push(local);
      }
    }

    return { merged, unaccountedFor, warnings };
  }

  /**
   * Cross-reference any pending-order records left over from a crash (see
   * pending-orders.ts / spec §8.2) against Bybit's own order history. Call
   * once at connect() time, alongside reconcilePositions().
   *
   * Deliberately returns diagnostic messages only — it does NOT touch the
   * journal or portfolio. Reconstructing a full journal TradeRecord needs
   * signal context (confidence, indicators, reason) that was never part of
   * the minimal pending-order record; auto-fabricating that context would be
   * exactly the anti-pattern the rest of this system has been removing. What
   * this adds over the generic "unaccounted-for position" reconcile warning
   * is specificity: it can say "this was OUR order" instead of leaving the
   * user to guess whether an unexplained position came from this bot or
   * something else entirely.
   *
   * Every pending record is cleared after this runs, resolved or not — a
   * startup check is the one meaningful chance to act on it; leaving it
   * around would just repeat the same stale check on every future restart.
   */
  async checkPendingOrders(): Promise<string[]> {
    const pending = getPendingOrders();
    if (pending.length === 0) return [];

    const warnings: string[] = [];
    for (const p of pending) {
      try {
        const history = await this.rest.getOrderHistory("linear", p.symbol, 20);
        const match = (history.list as any[]).find(o => o.orderLinkId === p.orderLinkId);
        const placedAt = new Date(p.timestamp).toISOString();
        if (match && (match.orderStatus === "Filled" || match.orderStatus === "PartiallyFilled")) {
          warnings.push(
            `Pending order for ${p.symbol} (${p.intent}, expected qty ${p.expectedQty}, placed ${placedAt}) was ` +
            `actually ${match.orderStatus} on Bybit (qty ${match.cumExecQty} @ ${match.avgPrice ?? match.price}) ` +
            `after this app lost track of it. This fill is likely NOT in your local journal — cross-check ` +
            `reconcilePositions() above and Bybit's order history for orderLinkId ${p.orderLinkId}.`,
          );
        } else if (match && (match.orderStatus === "Cancelled" || match.orderStatus === "Rejected")) {
          warnings.push(`Pending order for ${p.symbol} (placed ${placedAt}) was ${match.orderStatus} on Bybit — no fill occurred, safe to disregard.`);
        } else {
          warnings.push(`Pending order for ${p.symbol} (placed ${placedAt}, orderLinkId ${p.orderLinkId}) has an unknown status on Bybit — check manually.`);
        }
      } catch (err) {
        warnings.push(`Could not verify pending order for ${p.symbol} (orderLinkId ${p.orderLinkId}): ${(err as Error).message}`);
      } finally {
        clearPendingOrder(p.orderLinkId);
      }
    }
    return warnings;
  }

  /**
   * Pin leverage to 1x for every configured symbol and margin mode to isolated
   * for the account, then verify. See specs/live-trading-readiness.md §3.1 —
   * this is what makes the cash guardrail's "notional = capital at risk"
   * assumption actually true on a leveraged product, instead of silently false.
   *
   * `ok: false` means the safety invariant could not be confirmed at all and
   * the caller must halt everything (same severity as a fatal Bybit error) —
   * this is NOT a case to fall back to paper trading, which would silently
   * substitute fake data instead of surfacing the real problem.
   *
   * `restrictedSymbols` lists symbols where an already-open position blocked
   * the leverage change (a real, expected scenario for a crash-recovered
   * position — see spec §3.1) — these aren't fatal. The caller should block
   * new entries for them (they're safe to add to the existing haltedSymbols
   * mechanism) while leaving existing position management fully active.
   */
  async ensureLeverageAndMargin(): Promise<{ ok: boolean; restrictedSymbols: string[]; details: string[] }> {
    const details: string[] = [];
    const restrictedSymbols: string[] = [];
    let fatal = false;

    // Confirmed against a live testnet call (spec §12.3): setLeverage rejects
    // with retCode 110043 "leverage not modified" when the symbol is already at
    // the target leverage — this is the expected steady state after the first
    // successful pin on a later restart, and must be treated as success, not
    // failure. Matched by message substring (covers the confirmed case; kept
    // broad in case wording varies by endpoint/account type) rather than the
    // bare code, since classifyError() doesn't have a dedicated error class for
    // it and the raw SDK error's message is what's actually available here.
    const isNoChangeNeeded = (msg: string) => /not modified|already (set|in effect)|same as current|no need to modify/i.test(msg);

    try {
      await this.rest.setMarginMode("ISOLATED_MARGIN");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (isNoChangeNeeded(msg)) {
        logger.info(`[leverage] Margin mode already isolated (Bybit rejected the no-op change: "${msg}") — treating as confirmed, not a failure.`);
      } else {
        details.push(`Could not confirm isolated margin mode: ${msg}`);
        fatal = true;
      }
    }

    for (const bybitSymbol of this.config.symbols) {
      try {
        await this.rest.setLeverage("linear", bybitSymbol, "1");
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (isNoChangeNeeded(msg)) {
          logger.info(`[leverage] ${bybitSymbol} already at 1x (Bybit rejected the no-op change: "${msg}") — treating as confirmed, not a failure.`);
        } else {
          details.push(`setLeverage(${bybitSymbol}) was rejected (${msg}) — verifying actual position leverage.`);
        }
      }
    }

    // Read back actual leverage for every symbol with an open position — this
    // is the authoritative check, and it's load-bearing, not just a
    // double-check. Confirmed against live testnet (spec §12.3): when a
    // position is already open at a different leverage, setLeverage does NOT
    // throw at all — it resolves successfully while silently leaving the
    // position's actual leverage unchanged. There is no error to catch for
    // that case; this read-back is the only thing that catches it.
    try {
      const raw = await this.rest.getPositions("linear", undefined, "USDT");
      for (const pos of raw.list as BybitPosition[]) {
        if (Math.abs(Number.parseFloat(pos.size)) <= 0) continue; // no open position — nothing to verify
        if (pos.leverage !== "1") {
          const appSymbol = bybitSymbolToApp(pos.symbol);
          restrictedSymbols.push(appSymbol);
          details.push(
            `${pos.symbol} has an open position at ${pos.leverage}x leverage (expected 1x) — new entries ` +
            `blocked for this symbol until it's flat and leverage is re-pinned. Its stop-loss/take-profit ` +
            `and liquidation-buffer monitoring stay fully active.`,
          );
        }
      }
    } catch (err) {
      // Can't confirm the safety invariant for ANY symbol — this must halt
      // everything, not just proceed on faith.
      details.push(`Could not verify position leverage: ${(err as Error).message}`);
      fatal = true;
    }

    return { ok: !fatal, restrictedSymbols, details };
  }

  /** Fetch and cache lot size info for a symbol. */
  private async ensureLotSize(symbol: string): Promise<{ minQty: string; qtyStep: string } | null> {
    const bybitSymbol = symbol.replace("/", "");
    const cached = this.lotSizeCache.get(bybitSymbol);
    if (cached) return cached;

    try {
      const result = await this.rest.getInstruments("linear", bybitSymbol);
      // The response has a list of instruments
      const list = (result as any).list;
      if (list && list.length > 0) {
        const lotSizeFilter = list[0].lotSizeFilter;
        if (lotSizeFilter) {
          const info = {
            minQty: lotSizeFilter.minOrderQty || "0",
            qtyStep: lotSizeFilter.qtyStep || "0.001",
          };
          this.lotSizeCache.set(bybitSymbol, info);
          return info;
        }
      }
    } catch (err) {
      console.warn(`[bybit] Failed to fetch lot size for ${bybitSymbol}:`, (err as Error).message);
    }
    return null;
  }

  /** Get the minimum order quantity for a symbol. */
  async getMinQty(symbol: string): Promise<number> {
    const info = await this.ensureLotSize(symbol);
    return info ? Number.parseFloat(info.minQty) : 0.001;
  }

  /** Get the qty step for a symbol. */
  async getQtyStep(symbol: string): Promise<number> {
    const info = await this.ensureLotSize(symbol);
    return info ? Number.parseFloat(info.qtyStep) : 0.001;
  }

  /**
   * Place a post-only (maker) entry resting at the near touch, wait for it
   * to fill, and cancel it if it doesn't within the configured window.
   *
   * Why the near touch and not something more aggressive: a post-only order
   * that would immediately cross the spread is rejected outright by Bybit
   * (that's what "post only" means), so the price has to sit at or behind
   * the best price on our own side of the book. Buy rests at the best bid,
   * rounded DOWN to a tick; sell at the best ask, rounded UP.
   *
   * An unfilled order is cancelled and reported as a clean no-op (side
   * "hold", qty 0) — the same shape a rejected market order returns — so
   * the caller's books stay consistent with reality: nothing executed,
   * nothing to journal. Partial fills are journaled for exactly the
   * quantity that filled, then the remainder is cancelled.
   */
  private async placePostOnlyEntry(
    symbol: string, side: "Buy" | "Sell", formattedQty: string,
    orderLinkId: string, appSymbol: string,
  ): Promise<TradeResult> {
    const noop = (): TradeResult => ({ symbol: appSymbol, side: "hold", quantity: 0, price: 0, fee: 0, timestamp: Date.now() });

    let book: { bids: [string, string][]; asks: [string, string][] };
    try {
      book = await this.rest.getOrderbook("linear", symbol, 1);
    } catch (err) {
      logger.warn(`[bybit] Post-only entry for ${appSymbol} skipped — could not read the order book to price it (${(err as Error).message}). Not falling back to a market order: that would silently pay the taker fee the maker path exists to avoid.`);
      return noop();
    }

    const touch = side === "Buy" ? book.bids?.[0]?.[0] : book.asks?.[0]?.[0];
    const touchPrice = Number.parseFloat(touch ?? "");
    if (!Number.isFinite(touchPrice) || touchPrice <= 0) {
      logger.warn(`[bybit] Post-only entry for ${appSymbol} skipped — no ${side === "Buy" ? "bid" : "ask"} on the book to rest against.`);
      return noop();
    }

    const tick = await this.getTickSize(appSymbol);
    const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
    // Round away from the spread so the order rests instead of crossing.
    const resting = side === "Buy"
      ? Math.floor(touchPrice / tick) * tick
      : Math.ceil(touchPrice / tick) * tick;
    const price = resting.toFixed(decimals);

    let orderId: string;
    try {
      const order = await this.rest.placeOrder({
        category: "linear", symbol, side,
        orderType: "Limit", qty: formattedQty, price,
        timeInForce: "PostOnly", reduceOnly: false, orderLinkId,
      });
      orderId = (order as any).orderId as string;
    } catch (err) {
      // A PostOnly rejection means the book moved and the price would have
      // crossed — normal, not an error worth halting the symbol over.
      logger.warn(`[bybit] Post-only entry for ${appSymbol} at ${price} was not accepted (${(err as Error).message}) — treating as a no-op; the next cycle can try again at a fresh price.`);
      return noop();
    }

    const timeoutMs = this.config.postOnlyTimeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    // Poll cadence scales with the wait: a 5s timeout polls every 500ms
    // (10 checks), a 5-minute one every 5s (60 checks). The fixed 500ms
    // this used to have would have fired 600 REST calls for a single 300s
    // order and run straight into the rate limiter.
    const pollEveryMs = Math.min(5000, Math.max(500, Math.floor(timeoutMs / 60)));
    // NOTE: this await blocks the whole trading cycle until it resolves, so
    // with a long timeout no OTHER symbol is evaluated meanwhile — including
    // its stop-loss. That is safe as configured today (entries only rest
    // when flat, and only one symbol is traded), but it is a real hazard if
    // more symbols are added: an order resting 5 minutes on symbol A would
    // delay risk checks on symbol B. Making the rest non-blocking is the
    // proper fix and is not done here.
    logger.info(`[bybit] Post-only ${side} ${formattedQty} ${appSymbol} resting at ${price} (maker fee), waiting up to ${(timeoutMs / 1000).toFixed(0)}s for a fill, polling every ${(pollEveryMs / 1000).toFixed(1)}s.`);

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.min(pollEveryMs, Math.max(50, deadline - Date.now()))));
      const filled = await this.pollForFill(symbol, orderId, 1);
      if (filled && filled.side !== "hold" && filled.quantity > 0) {
        logger.info(`[bybit] Post-only ${side} ${appSymbol} filled ${filled.quantity} @ ${filled.price} (maker).`);
        return filled;
      }
    }

    // Didn't fill in the window. Cancel and report nothing executed. Cancel
    // is best-effort but its failure is logged loudly rather than swallowed:
    // a still-resting order the bot has forgotten about is a real exposure.
    let cancelError: Error | null = null;
    try {
      await this.rest.cancelOrder("linear", symbol, orderId);
    } catch (err) {
      cancelError = err as Error;
    }

    // Always reconcile against the exchange before reporting anything: a
    // cancel routinely races a fill, and Bybit's "order not exists or too
    // late to cancel" (110001) means the order is GONE — usually because it
    // just filled — not that it's still resting. Logging the cancel failure
    // before checking produced a scary "may still be resting, check Bybit
    // manually" error that the very next line then contradicted with the
    // real fill. Ask first, then log once, correctly.
    const afterCancel = await this.pollForFill(symbol, orderId, 1);
    if (afterCancel && afterCancel.side !== "hold" && afterCancel.quantity > 0) {
      logger.info(`[bybit] Post-only ${side} ${appSymbol} filled ${afterCancel.quantity} @ ${afterCancel.price} (maker) as the cancel was being sent — journaling the real fill, nothing is left resting.`);
      return afterCancel;
    }

    if (cancelError === null) {
      logger.info(`[bybit] Post-only ${side} ${appSymbol} did not fill within ${timeoutMs}ms — cancelled, nothing executed.`);
    } else {
      // Cancel failed AND no fill came back. Now it's genuinely ambiguous
      // and worth a human looking, which is what ERROR is for.
      logger.error(`[bybit] Post-only ${side} ${appSymbol} did not fill, the cancel failed (${cancelError.message}), and no fill could be confirmed afterwards — order ${orderId} may still be resting on the exchange. Check Bybit manually.`);
    }
    return noop();
  }

  /**
   * Price tick size for a symbol, needed to round a limit price to a value
   * the exchange will accept. Cached like lot size; falls back to a
   * conservative 0.0001 only if the instrument lookup fails, in which case
   * the caller's rounding is merely coarse, never invalid.
   */
  async getTickSize(symbol: string): Promise<number> {
    const bybitSymbol = symbol.replace("/", "");
    const cached = this.tickSizeCache.get(bybitSymbol);
    if (cached !== undefined) return cached;
    try {
      const result = await this.rest.getInstruments("linear", bybitSymbol);
      const list = (result as any).list;
      const tick = list?.[0]?.priceFilter?.tickSize;
      if (tick) {
        const parsed = Number.parseFloat(tick);
        if (Number.isFinite(parsed) && parsed > 0) {
          this.tickSizeCache.set(bybitSymbol, parsed);
          return parsed;
        }
      }
    } catch (err) {
      logger.warn(`[bybit] Failed to fetch tick size for ${bybitSymbol}: ${(err as Error).message}`);
    }
    return 0.0001;
  }

  /**
   * Validate and round quantity to meet lot size rules.
   *
   * `side` controls rounding direction — this matters for safety, not just
   * precision (see specs/live-trading-readiness.md §4.2). A BUY rounds to the
   * nearest step (rounding up costs a few extra cents of notional, harmless).
   * A SELL always rounds DOWN: rounding a close UP past the quantity actually
   * held, combined with reduceOnly, would either get rejected or — without
   * reduceOnly — open a naked short for the difference. Flooring means a sell
   * request can undershoot what's held (leaving a dust remainder) but can
   * never overshoot it.
   */
  async validateQty(symbol: string, qty: number, side: "buy" | "sell"): Promise<number | null> {
    const minQty = await this.getMinQty(symbol);
    const qtyStep = await this.getQtyStep(symbol);

    const steps = side === "sell" ? Math.floor(qty / qtyStep) : Math.round(qty / qtyStep);
    const roundedQty = steps * qtyStep;

    // Check minimum
    if (roundedQty < minQty) {
      return null; // qty too small
    }

    return roundedQty;
  }

  /** Place an order via REST API with exact quantity. */
  async placeOrder(signal: TradeSignal, qty: number, maxCostUsd?: number): Promise<TradeResult> {
    // Convert app signal to Bybit order
    const symbol = signal.symbol.replace("/", "");
    const side = signal.type === "buy" ? "Buy" : "Sell";
    // In this app a "sell" is always closing an existing position (main.ts only
    // ever emits one after confirming a local position exists) — never opening
    // a short. reduceOnly makes that invariant authoritative at the exchange:
    // if local state is ever wrong about what's actually held, Bybit rejects
    // the excess instead of silently opening a short (see spec §4.1).
    const reduceOnly = signal.type === "sell";

    // Validate qty against lot size rules
    const validQty = await this.validateQty(signal.symbol, qty, signal.type === "buy" ? "buy" : "sell");
    let formattedQty = "";
    let actualQty = 0;
    if (validQty === null) {
      if (reduceOnly) {
        // The position (or what's left of it) is below the exchange's minimum
        // tradeable size. Forcing a sell up to minQty here would either get
        // rejected for exceeding the real holding, or — without reduceOnly —
        // open a short for the excess. Neither is acceptable; surface it
        // instead of guessing.
        logger.warn(`[bybit] ${signal.symbol} close quantity (${qty}) rounds below the exchange minimum — cannot safely close via market order. Skipping; check the position on Bybit manually.`);
        return { symbol: signal.symbol, side: "hold", quantity: 0, price: 0, fee: 0, timestamp: Date.now() };
      }
      // Buy, qty too small — use minimum possible.
      const minQty = await this.getMinQty(signal.symbol);
      formattedQty = minQty.toFixed(4);
      actualQty = minQty;
    } else {
      // Format using the qty step for precision
      const qtyStep = await this.getQtyStep(signal.symbol);
      const decimals = Math.max(0, Math.ceil(-Math.log10(qtyStep)));
      formattedQty = validQty.toFixed(decimals);
      actualQty = validQty;
    }

    // Check if we can afford this order (for buy signals)
    if (side === "Buy" && maxCostUsd !== undefined) {
      // We need a price estimate — use the last cached price from tickers
      const lastSnapshot = this.lastSnapshots.get(signal.symbol);
      const estimatedPrice = lastSnapshot?.price ?? 0;
      if (estimatedPrice > 0) {
        const estimatedCost = actualQty * estimatedPrice * 1.001; // +0.1% fee buffer
        if (estimatedCost > maxCostUsd) {
          logger.warn(`Order would cost ~$${estimatedCost.toFixed(2)} but only $${maxCostUsd.toFixed(2)} available — skipping`);
          return {
            symbol: signal.symbol,
            side: "hold",
            quantity: 0,
            price: 0,
            fee: 0,
            timestamp: Date.now(),
          };
        }
      }
    }

    // Persist a minimal pending-order record BEFORE sending, so a crash
    // between this call returning and the trade being journaled leaves
    // enough information for a specific diagnostic at next startup instead
    // of a generic "unaccounted-for position" (see spec §8.2). Cleared on
    // every return path below — success, confirmed rejection, or exhausted
    // polling — so it never accumulates stale entries during normal operation.
    const orderLinkId = randomUUID();
    recordPendingOrder({ orderLinkId, symbol, intent: signal.type === "buy" ? "buy" : "sell", expectedQty: actualQty, timestamp: Date.now() });

    // Post-only (maker) entries — see config.usePostOnlyEntries. Applies to
    // ENTRIES ONLY: `reduceOnly` marks a close, and a close must never rest
    // unfilled while price runs against the position, which is the exact
    // failure the stop-loss exists to prevent. Closes always go to market.
    if (this.config.usePostOnlyEntries && !reduceOnly) {
      try {
        const maker = await this.placePostOnlyEntry(symbol, side, formattedQty, orderLinkId, signal.symbol);
        return maker;
      } finally {
        clearPendingOrder(orderLinkId);
      }
    }

    try {
      const order = await this.rest.placeOrder({
        category: "linear",
        symbol,
        side,
        orderType: "Market",
        qty: formattedQty,
        reduceOnly,
        orderLinkId,
      });

      try {
        return orderResponseToTradeResult(order as unknown as BybitOrderResponse);
      } catch (err) {
        if (!(err instanceof BybitFillUncertainError)) throw err;
        // Bybit accepted the order (we have an orderId) but the immediate ack didn't
        // carry a parseable fill yet — market fills can lag the REST response by a
        // few hundred ms. Poll order history briefly instead of fabricating a trade
        // result, which previously corrupted portfolio.cashUsd into NaN forever.
        logger.warn(`[bybit] ${err.message} — polling order history for the confirmed fill...`);
        const confirmed = await this.pollForFill(symbol, (order as any).orderId as string);
        if (confirmed) return confirmed;
        logger.error(`[bybit] Could not confirm fill for order ${(order as any).orderId} (orderLinkId=${orderLinkId}) after polling — check Bybit manually.`);
        throw err;
      }
    } finally {
      clearPendingOrder(orderLinkId);
    }
  }

  /**
   * Poll order history briefly for a confirmed fill after an ambiguous ack.
   * Accepts "PartiallyFilled" as a valid (if incomplete) result — Bybit's
   * cumExecQty/avgPrice/cumExecFee are already running totals, not deltas, so
   * the latest poll's numbers are the whole picture, not something to sum
   * across attempts (see spec §4.3). Returns AT MOST one TradeResult — the
   * caller journals it exactly once — never one per partial-fill observation,
   * which would create duplicate Position rows (portfolio.ts has no
   * same-symbol merge logic for repeated "buy" updates).
   */
  private async pollForFill(symbol: string, orderId: string, maxAttempts = 4): Promise<TradeResult | null> {
    let lastPartial: TradeResult | null = null;
    let lastLeavesQty: string | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // The post-only path polls in a tight loop it paces itself, so it asks
      // for a single immediate check rather than this backoff.
      if (maxAttempts > 1) await sleep(400 * (attempt + 1));
      try {
        const history = await this.rest.getOrderHistory("linear", symbol, 10);
        const match = (history.list as any[]).find(o => o.orderId === orderId);
        if (!match) continue;

        if (match.orderStatus === "Filled") {
          try {
            return orderResponseToTradeResult(match as BybitOrderResponse);
          } catch {
            continue; // still unparseable — keep polling
          }
        }

        if (match.orderStatus === "Cancelled" || match.orderStatus === "Rejected") {
          // Terminal — nothing about this order will change further, so
          // there's no reason to keep polling. Market orders are IOC
          // (immediate-or-cancel) by default: if there's no immediate
          // liquidity to match against, Bybit cancels the whole order rather
          // than leaving it open — this is a normal, safe outcome (observed
          // live: three separate GRT/USDT buys all cancelled this exact way
          // with cumExecQty=0, "EC_NoImmediateQtyToFill", on a thin testnet
          // book), not an "uncertain" fill that needs escalating to the user.
          const cumQty = Number.parseFloat(match.cumExecQty ?? "0");
          if (cumQty > 0) {
            try {
              logger.warn(`[bybit] Order ${orderId} (${symbol}) was ${match.orderStatus} after partially filling qty=${cumQty} — journaling that partial fill; the remainder was never executed.`);
              return orderResponseToTradeResult(match as BybitOrderResponse);
            } catch {
              // Unparseable even here — fall through to the zero-fill message
              // below, which is still accurate: nothing usable to journal.
            }
          }
          logger.warn(
            `[bybit] Order ${orderId} (${symbol}) was ${match.orderStatus} with zero fill` +
            `${match.rejectReason ? ` (${match.rejectReason})` : ""} — likely no immediate liquidity available for ` +
            `a market order. Treating as a clean no-op: nothing executed, nothing to journal.`,
          );
          return { symbol: bybitSymbolToApp(symbol), side: "hold", quantity: 0, price: 0, fee: 0, timestamp: Date.now() };
        }

        if (match.orderStatus === "PartiallyFilled") {
          try {
            const partial = orderResponseToTradeResult(match as BybitOrderResponse);
            if (partial.quantity > 0) {
              lastPartial = partial;
              lastLeavesQty = match.leavesQty;
            }
          } catch {
            // still unparseable even for the partial — keep polling
          }
        }
      } catch (err) {
        console.warn(`[bybit] Fill-status poll failed for order ${orderId}:`, (err as Error).message);
      }
    }
    if (lastPartial) {
      logger.warn(
        `[bybit] Order ${orderId} (${symbol}) only partially filled after polling: qty=${lastPartial.quantity} ` +
        `filled, remaining leavesQty=${lastLeavesQty}. Journaling the partial fill — the remainder was NOT executed ` +
        `and is not tracked as a separate trade.`,
      );
      return lastPartial;
    }
    return null;
  }

  /** Get current positions from Bybit. */
  async getPositions(): Promise<Position[]> {
    // Bybit's /v5/position/list requires either `symbol` or `settleCoin` for
    // category=linear when listing all positions — without one it rejects the
    // request with error 10001. USDT is the settle coin for every symbol this
    // app trades (see adapters.ts appSymbolToBybit), so it's a safe default.
    const result = await this.rest.getPositions("linear", undefined, "USDT");
    return (result.list as BybitPosition[]).map(bybitPositionToPosition);
  }

  /** Get wallet balance (for display only — NEVER used as operating capital). */
  async getWalletBalance(): Promise<{ totalUsd: number; coin: string; available: string }[]> {
    const result = await this.rest.getWalletBalance();
    return (result.list as BybitWalletBalance[]).map(w => ({
      totalUsd: Number.parseFloat(w.usdValue || "0"),
      coin: w.coin,
      available: w.availableBalance,
    }));
  }

  /**
   * Sum funding fee settlements across all configured symbols since `sinceMs`.
   * See spec §3.3. Per-symbol failures are logged and skipped rather than
   * failing the whole call, so one symbol's API hiccup doesn't hide funding
   * on the rest.
   *
   * IMPORTANT — sign convention is NOT verified against a live Bybit response.
   * `execFee`'s polarity for a trading fee (positive = cost to you) is well
   * established in this codebase already (see adapters.ts's TradeResult.fee,
   * always subtracted from P&L) — but funding is a payment *between* position
   * holders, not a fee paid to the exchange, and Bybit's docs are not
   * unambiguous from static reading alone on whether execFee keeps the same
   * polarity for execType "Funding". This returns the raw summed execFee,
   * NEGATED to match the trading-fee convention (positive execFee = cost =
   * negative P&L) as the more likely default — but treat this as a best
   * guess: verify against an actual testnet funding settlement (spec §12.3)
   * before trusting the sign, and flip FUNDING_SIGN below if it's backwards.
   */
  async getFundingPnlSince(sinceMs: number): Promise<number> {
    const FUNDING_SIGN = -1; // UNVERIFIED — see doc comment above.
    let total = 0;
    for (const bybitSymbol of this.config.symbols) {
      try {
        const res = await this.rest.getFundingHistory("linear", bybitSymbol, sinceMs);
        for (const exec of res.list as any[]) {
          const fee = Number.parseFloat(exec.execFee ?? "0");
          if (!Number.isNaN(fee)) total += FUNDING_SIGN * fee;
        }
      } catch (err) {
        logger.warn(`[bybit] Failed to fetch funding history for ${bybitSymbol}: ${(err as Error).message}`);
      }
    }
    return total;
  }

  /** Register callbacks. */
  onTicker(handler: TickerHandler): void { this.tickerHandlers.add(handler); }
  onTrade(handler: TradeHandler): void { this.tradeHandlers.add(handler); }
  onPosition(handler: PositionHandler): void { this.positionHandlers.add(handler); }
  /** Unadapted position updates — use for leverage/liquidationPrice, which
   *  onPosition's adapted Position type doesn't carry (spec §3.2/§3.4). */
  onRawPosition(handler: RawPositionHandler): void { this.rawPositionHandlers.add(handler); }
  onConnection(handler: ConnectionHandler): void { this.connectionHandlers.add(handler); }

  // ── Internal Handlers ─────────────────────────────────────────────

  private handleTicker(topic: string, data: unknown): void {
    const tickerData = (data as { symbol?: string; lastPrice?: string; price24hPcnt?: string; volume24h?: string; turnover24h?: string });
    if (!tickerData) return;

    // Robust symbol fallback from topic name if missing in delta
    const bybitSymbol = tickerData.symbol || topic.split(".")[1] || "";
    if (!bybitSymbol) return;

    // Convert to app format (e.g., BTC/USDT)
    const appSymbol = bybitSymbolToApp(bybitSymbol);
    const previous = this.lastSnapshots.get(appSymbol);

    // Update latency & ticker timestamp
    this._state.latencyMs = this.wsPublic.getLatencyMs();
    this._state.lastTickerTime = Date.now();

    // Convert to MarketSnapshot using delta-merging with previous cached state
    const snapshot = tickerToMarketSnapshot({ ...tickerData, symbol: bybitSymbol }, previous);
    this.lastSnapshots.set(appSymbol, snapshot);

    const snapshots = new Map<string, MarketSnapshot>();
    snapshots.set(snapshot.symbol, snapshot);

    for (const handler of this.tickerHandlers) {
      handler(snapshots);
    }
  }

  private handleOrder(data: unknown): void {
    const orderData = data as any;
    if (!orderData || !orderData.symbol) return;

    // Only handle filled orders
    if (orderData.orderStatus === "Filled") {
      const result = orderResponseToTradeResult(orderData);
      for (const handler of this.tradeHandlers) {
        handler(result);
      }
    }
  }

  private handlePosition(data: unknown): void {
    const posData = data as any;
    if (!posData || !Array.isArray(posData)) return;

    for (const handler of this.rawPositionHandlers) {
      handler(posData as BybitPosition[]);
    }

    const positions = posData.map((p: any) => bybitPositionToPosition(p));
    for (const handler of this.positionHandlers) {
      handler(positions);
    }
  }

  private notifyConnection(): void {
    for (const handler of this.connectionHandlers) {
      handler(this._state);
    }
  }
}