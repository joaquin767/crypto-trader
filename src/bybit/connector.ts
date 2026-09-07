// Bybit Connector — ties together REST client, WebSocket client, and adapters.
// Manages connection lifecycle, data flow, and error recovery.

import { RestClient } from "./rest.ts";
import { WsClient } from "./ws.ts";
import { BybitConnectionError, type BybitConfig, type BybitApiError, type BybitOrderResponse, type BybitPosition, type BybitWalletBalance } from "./types.ts";
import type { MarketSnapshot } from "../market.ts";
import type { TradeResult } from "../executor.ts";
import type { TradeSignal } from "../strategy/signals.ts";
import type { Position } from "../portfolio.ts";
import { tickerToMarketSnapshot, orderResponseToTradeResult, bybitPositionToPosition, bybitSymbolToApp } from "./adapters.ts";
import { logger } from "../logger.ts";

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

  constructor(config: BybitConfig) {
    this.config = config;
    this.rest = new RestClient(config);
    this.wsPublic = new WsClient(config, false);
    this.wsPrivate = new WsClient(config, true);

    this._state = {
      connected: false,
      mode: config.testnet ? "testnet" : "live",
      latencyMs: 0,
      lastTickerTime: 0,
      error: null,
    };
  }

  get state(): BybitConnectorState {
    return { ...this._state };
  }

  /** Connect to Bybit: sync time, start WebSocket streams, subscribe to topics. */
  async connect(): Promise<void> {
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
    this.wsPublic.disconnect();
    this.wsPrivate.disconnect();
    this._connected = false;
    this._state.connected = false;
    this._state.error = null;
    this.notifyConnection();
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

    const order = await this.rest.placeOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: formattedQty,
      reduceOnly: false,
    });

    return orderResponseToTradeResult(order as unknown as BybitOrderResponse);
  }

  /** Get current positions from Bybit. */
  async getPositions(): Promise<Position[]> {
    const result = await this.rest.getPositions("linear");
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