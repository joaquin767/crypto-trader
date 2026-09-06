// Bybit Connector — ties together REST client, WebSocket client, and adapters.
// Manages connection lifecycle, data flow, and error recovery.

import { RestClient } from "./rest.ts";
import { WsClient } from "./ws.ts";
import { BybitConnectionError, type BybitConfig, type BybitApiError } from "./types.ts";
import type { MarketSnapshot } from "../market.ts";
import type { TradeResult } from "../executor.ts";
import type { TradeSignal } from "../strategy/signals.ts";
import type { Position } from "../portfolio.ts";
import { tickerToMarketSnapshot, orderResponseToTradeResult, bybitPositionToPosition } from "./adapters.ts";

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
      this.wsPublic.on("ticker", (topic: string, data: unknown) => {
        this.handleTicker(topic, data);
      });

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
    this.notifyConnection();
  }

  /** Place an order via REST API. */
  async placeOrder(signal: TradeSignal): Promise<TradeResult> {
    // Convert app signal to Bybit order
    const symbol = signal.symbol.replace("/", "");
    const side = signal.type === "buy" ? "Buy" : "Sell";

    const order = await this.rest.placeOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: "1", // Will be set by the caller based on position sizing
      reduceOnly: false,
    });

    return orderResponseToTradeResult(order);
  }

  /** Get current positions from Bybit. */
  async getPositions(): Promise<Position[]> {
    const result = await this.rest.getPositions("linear");
    return result.list.map(bybitPositionToPosition);
  }

  /** Get wallet balance (for display only — NEVER used as operating capital). */
  async getWalletBalance(): Promise<{ totalUsd: number; coin: string; available: string }[]> {
    const result = await this.rest.getWalletBalance();
    return result.list.map(w => ({
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
    const tickerData = (data as { symbol: string; lastPrice: string; price24hPcnt: string; volume24h: string; turnover24h: string });
    if (!tickerData || !tickerData.symbol) return;

    // Update latency
    this._state.latencyMs = this.wsPublic.getLatencyMs();
    this._state.lastTickerTime = Date.now();

    // Convert to MarketSnapshot and broadcast
    const snapshot = tickerToMarketSnapshot(tickerData as any);
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