// Bybit REST API client — wraps the official bybit-official-ts-sdk
// and exposes the same interface our custom RestClient used to.
// This gives us Bybit-maintained REST logic with our custom WebSocket/connector layers.

import { BybitClient, BybitApiError as SdkApiError, BybitAuthError as SdkAuthError, BybitRateLimitError as SdkRateLimitError } from "bybit-official-ts-sdk";
import type { BybitConfig } from "./types.ts";
import { BybitConnectionError, BybitConfigError } from "./types.ts";
import { classifyError } from "./types.ts";

export interface RestClientOptions {
  timeoutMs?: number;
  recvWindowMs?: number;
}

export class RestClient {
  private config: BybitConfig;
  private client: BybitClient;
  private serverTimeDiff = 0;
  private lastTimeSync = 0;

  constructor(config: BybitConfig, opts: RestClientOptions = {}) {
    this.config = config;

    if (!config.apiKey || !config.apiSecret) {
      throw new BybitConfigError("API key and secret are required");
    }

    const recvWindow = opts.recvWindowMs ?? 5000;
    const timeout = opts.timeoutMs ?? 10000;

    this.client = new BybitClient({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      testnet: config.testnet,
      recvWindow: String(recvWindow),
      timeout,
    });
  }

  async syncTime(): Promise<number> {
    const start = Date.now();
    try {
      const res = await this.client.market.getServerTime();
      const end = Date.now();
      const rtt = end - start;
      const serverTime = Number(res.result.timeSecond) * 1000;
      this.serverTimeDiff = serverTime - (start + rtt / 2);
      this.lastTimeSync = Date.now();
      console.log(`[bybit] Time synced: diff=${this.serverTimeDiff}ms, rtt=${rtt}ms`);
      return this.serverTimeDiff;
    } catch (err) {
      throw new BybitConnectionError(`Time sync failed: ${(err as Error).message}`);
    }
  }

  async getTickers(category: string, symbol?: string): Promise<{ category: string; list: unknown[] }> {
    const res = await this.client.market.getTickers({ category, symbol });
    return res.result as any;
  }

  async getKline(
    category: string, symbol: string, interval: string,
    start?: number, end?: number, limit?: number,
  ): Promise<{ category: string; symbol: string; list: string[][] }> {
    const res = await this.client.market.getMarketKline({
      category, symbol, interval,
      start: start ?? 0,
      end: end ?? 0,
      limit: limit ?? 200,
    });
    return res.result as any;
  }

  async getOrderbook(category: string, symbol: string, level = 25): Promise<{ bids: [string, string][]; asks: [string, string][]; timestamp: number }> {
    const res = await this.client.market.getOrderbook({ category, symbol, limit: level });
    const data = res.result as any;
    return { bids: data.b, asks: data.a, timestamp: res.time };
  }

  async getInstruments(category: string, symbol?: string): Promise<{ category: string; list: unknown[] }> {
    const res = await this.client.market.getInstrumentsInfo({ category, symbol });
    return res.result as any;
  }

  async getRecentTrades(category: string, symbol: string, limit?: number): Promise<{ category: string; list: unknown[] }> {
    const res = await this.client.market.getRecentPublicTrades({ category, symbol, limit });
    return res.result as any;
  }

  async placeOrder(order: {
    category: string; symbol: string; side: string; orderType: string;
    qty: string; price?: string; timeInForce?: string;
    reduceOnly?: boolean; orderLinkId?: string;
    takeProfit?: string; stopLoss?: string;
  }): Promise<{
    orderId: string; orderLinkId: string; orderStatus: string;
    symbol: string; side: string; price: string; qty: string;
    leavesQty: string; cumExecQty: string; cumExecFee: string;
    cumExecValue?: string; avgPrice?: string; createdTime: string;
  }> {
    try {
      const res = await this.client.trade.createOrder(order);
      return res.result as any;
    } catch (err) {
      if (err instanceof SdkAuthError) {
        throw classifyError(err.retCode ?? 10003, err.message);
      }
      if (err instanceof SdkRateLimitError) {
        throw classifyError(err.retCode ?? 10006, err.message);
      }
      if (err instanceof SdkApiError) {
        throw classifyError(err.retCode ?? 10001, err.message);
      }
      throw err;
    }
  }

  async cancelOrder(category: string, symbol: string, orderId: string): Promise<void> {
    await this.client.trade.cancelOrder({ category, symbol, orderId });
  }

  async getOpenOrders(category: string, symbol?: string): Promise<{ list: unknown[] }> {
    const res = await this.client.trade.getOpenOrders({ category, symbol });
    return res.result as any;
  }

  async getOrderHistory(category: string, symbol?: string, limit?: number): Promise<{ list: unknown[] }> {
    const res = await this.client.trade.getOrderHistory({ category, symbol, limit });
    return res.result as any;
  }

  async getPositions(category: string, symbol?: string): Promise<{ list: unknown[] }> {
    const res = await this.client.position.getPositionInfo({ category, symbol });
    return res.result as any;
  }

  async getWalletBalance(coin?: string): Promise<{ list: unknown[] }> {
    const res = await this.client.account.getWalletBalance({ accountType: "UNIFIED", coin });
    return res.result as any;
  }
}