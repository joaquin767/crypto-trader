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

    // Bybit rejects both calls with a specific error when the target is already
    // in effect (the expected steady state after the first successful pin on a
    // later restart). The exact retCode for that hasn't been verified against
    // live Bybit responses (see rest.ts's setLeverage/setMarginMode docs) — so
    // rather than guess a numeric code and risk silently swallowing a real
    // failure, this matches the documented phrasing Bybit uses for "no change
    // needed" rejections. If a real Bybit response uses different wording,
    // this needs updating against an actual testnet run — see spec §12.3.
    const isNoChangeNeeded = (msg: string) => /not modified|already (set|in effect)|same as current|no need to modify/i.test(msg);

    try {
      await this.rest.setMarginMode("ISOLATED_MARGIN");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!isNoChangeNeeded(msg)) {
        details.push(`Could not confirm isolated margin mode: ${msg}`);
        fatal = true;
      }
    }

    for (const bybitSymbol of this.config.symbols) {
      try {
        await this.rest.setLeverage("linear", bybitSymbol, "1");
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!isNoChangeNeeded(msg)) {
          // Could be a genuine failure, or an open position blocking the change
          // (spec §3.1's second integration subtlety) — the position read-back
          // below is the authoritative check either way, so just note it here.
          details.push(`setLeverage(${bybitSymbol}) was rejected (${msg}) — verifying actual position leverage.`);
        }
      }
    }

    // Read back actual leverage for every symbol with an open position — this
    // is the authoritative check. setLeverage can succeed with no error and
    // still not reflect what's really configured if it silently no-ops for a
    // reason we didn't anticipate, and a position blocking the change (above)
    // needs this to determine which specific symbol is affected.
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

    const orderLinkId = randomUUID();
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
  }

  /** Poll order history briefly for a confirmed fill after an ambiguous ack. */
  private async pollForFill(symbol: string, orderId: string): Promise<TradeResult | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(400 * (attempt + 1));
      try {
        const history = await this.rest.getOrderHistory("linear", symbol, 10);
        const match = (history.list as any[]).find(o => o.orderId === orderId);
        if (match && match.orderStatus === "Filled") {
          try {
            return orderResponseToTradeResult(match as BybitOrderResponse);
          } catch {
            continue; // still unparseable — keep polling
          }
        }
      } catch (err) {
        console.warn(`[bybit] Fill-status poll failed for order ${orderId}:`, (err as Error).message);
      }
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