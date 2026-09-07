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
export type ConnectionHandler = (state: BybitConnectorState) => void;

export class BybitConnector {
  public config: BybitConfig;
  public rest: RestClient;
  public wsPublic: WsClient;
  public wsPrivate: WsClient;

  private tickerHandlers = new Set<TickerHandler>();
  private tradeHandlers = new Set<TradeHandler>();
  private positionHandlers = new Set<PositionHandler>();
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

  /** Validate and round quantity to meet lot size rules. */
  async validateQty(symbol: string, qty: number): Promise<number | null> {
    const minQty = await this.getMinQty(symbol);
    const qtyStep = await this.getQtyStep(symbol);

    // Round to the nearest valid qty step
    const steps = Math.round(qty / qtyStep);
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

    // Validate qty against lot size rules
    const validQty = await this.validateQty(signal.symbol, qty);
    let formattedQty = "";
    let actualQty = 0;
    if (validQty === null) {
      // qty too small — use minimum possible
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
      reduceOnly: false,
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