// Bybit REST API client — wraps the official bybit-official-ts-sdk
// and exposes the same interface our custom RestClient used to.
// This gives us Bybit-maintained REST logic with our custom WebSocket/connector layers.
//
// Reliability layer added on top of the SDK (see docs/bybit-integration spec §7/§9):
// - Per-endpoint token-bucket rate limiting (EndpointRateLimiter), so we never
//   hammer an endpoint fast enough to trip Bybit's own limiter or an IP ban.
// - One retry with backoff for ambiguous network/timeout failures on read-only
//   endpoints (a structured Bybit error is never retried — it's a real answer).
// - placeOrder() always carries an orderLinkId. If the create call fails with an
//   ambiguous (non-API) error, we retry EXACTLY ONCE with the SAME orderLinkId so
//   Bybit's own dedup prevents a double fill; a confirmed rejection is never
//   retried (avoids accidental double-execution, per spec §7).

import { randomUUID } from "node:crypto";
import { BybitClient, BybitApiError as SdkApiError, BybitAuthError as SdkAuthError, BybitRateLimitError as SdkRateLimitError } from "bybit-official-ts-sdk";
import type { BybitConfig } from "./types.ts";
import { BybitApiError, BybitConnectionError, BybitConfigError } from "./types.ts";
import { classifyError } from "./types.ts";
import { EndpointRateLimiter } from "./rate-limiter.ts";

export interface RestClientOptions {
  timeoutMs?: number;
  recvWindowMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RestClient {
  private config: BybitConfig;
  private client: BybitClient;
  private serverTimeDiff = 0;
  private lastTimeSync = 0;
  private limiter = new EndpointRateLimiter();

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

  /**
   * Run a read-only (idempotent) REST call: rate-limited, and retried once on an
   * ambiguous network/timeout failure. A structured Bybit error (auth, rate-limit,
   * business rejection) is classified and thrown immediately — never retried blindly.
   */
  private async withReadRetry<T>(path: string, fn: () => Promise<T>): Promise<T> {
    await this.limiter.acquire(path);
    try {
      return await fn();
    } catch (err) {
      const classified = this.classifyOrNull(path, err);
      if (classified) throw classified;

      // Not a structured Bybit response — likely a network/timeout blip. Retry once.
      await sleep(400);
      await this.limiter.acquire(path);
      try {
        return await fn();
      } catch (err2) {
        const classified2 = this.classifyOrNull(path, err2);
        if (classified2) throw classified2;
        throw err2;
      }
    }
  }

  /** Classify a caught error into our error types if it's a structured SDK error; else null. */
  private classifyOrNull(path: string, err: unknown): Error | null {
    if (err instanceof SdkAuthError) return classifyError(err.retCode ?? 10003, err.message);
    if (err instanceof SdkRateLimitError) {
      this.limiter.reportRateLimited(path);
      return classifyError(err.retCode ?? 10006, err.message);
    }
    if (err instanceof SdkApiError) return classifyError(err.retCode ?? 10001, err.message);
    return null;
  }

  async syncTime(): Promise<number> {
    const path = "/v5/market/time";
    const attemptOnce = async (): Promise<number> => {
      await this.limiter.acquire(path);
      const start = Date.now();
      const res = await this.client.market.getServerTime();
      const end = Date.now();
      const rtt = end - start;
      const serverTime = Number(res.result.timeSecond) * 1000;
      this.serverTimeDiff = serverTime - (start + rtt / 2);
      this.lastTimeSync = Date.now();
      console.log(`[bybit] Time synced: diff=${this.serverTimeDiff}ms, rtt=${rtt}ms`);
      return this.serverTimeDiff;
    };

    try {
      return await attemptOnce();
    } catch (err) {
      try {
        await sleep(400);
        return await attemptOnce();
      } catch (err2) {
        throw new BybitConnectionError(`Time sync failed: ${(err2 as Error).message}`);
      }
    }
  }

  async getTickers(category: string, symbol?: string): Promise<{ category: string; list: unknown[] }> {
    return this.withReadRetry("/v5/market/tickers", async () => {
      const res = await this.client.market.getTickers({ category, symbol });
      return res.result as any;
    });
  }

  async getKline(
    category: string, symbol: string, interval: string,
    start?: number, end?: number, limit?: number,
  ): Promise<{ category: string; symbol: string; list: string[][] }> {
    return this.withReadRetry("/v5/market/kline", async () => {
      const res = await this.client.market.getMarketKline({
        category, symbol, interval,
        start: start ?? 0,
        end: end ?? 0,
        limit: limit ?? 200,
      });
      return res.result as any;
    });
  }

  async getOrderbook(category: string, symbol: string, level = 25): Promise<{ bids: [string, string][]; asks: [string, string][]; timestamp: number }> {
    return this.withReadRetry("/v5/market/orderbook", async () => {
      const res = await this.client.market.getOrderbook({ category, symbol, limit: level });
      const data = res.result as any;
      return { bids: data.b, asks: data.a, timestamp: res.time };
    });
  }

  async getInstruments(category: string, symbol?: string): Promise<{ category: string; list: unknown[] }> {
    return this.withReadRetry("/v5/market/instruments", async () => {
      const res = await this.client.market.getInstrumentsInfo({ category, symbol });
      return res.result as any;
    });
  }

  async getRecentTrades(category: string, symbol: string, limit?: number): Promise<{ category: string; list: unknown[] }> {
    return this.withReadRetry("/v5/market/recent-trade", async () => {
      const res = await this.client.market.getRecentPublicTrades({ category, symbol, limit });
      return res.result as any;
    });
  }

  /**
   * Place a market/limit order. Always carries an orderLinkId (generated if the
   * caller didn't supply one) so a retry after an ambiguous failure can never
   * result in Bybit accepting the same order twice.
   *
   * A confirmed rejection (a real Bybit error response) is thrown immediately and
   * NEVER retried — per spec §7, auto-retrying a rejected order risks double
   * execution. Only a genuinely ambiguous failure (no response at all — timeout,
   * network drop) gets a single retry, reusing the same orderLinkId.
   */
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
    const orderLinkId = order.orderLinkId ?? randomUUID();
    const orderWithLinkId = { ...order, orderLinkId };
    const path = "/v5/order/create";

    const attemptOnce = async () => {
      await this.limiter.acquire(path);
      try {
        const res = await this.client.trade.createOrder(orderWithLinkId);
        return res.result as any;
      } catch (err) {
        const classified = this.classifyOrNull(path, err);
        if (classified) throw classified;
        throw err; // ambiguous — no structured Bybit response
      }
    };

    try {
      return await attemptOnce();
    } catch (err) {
      if (err instanceof BybitApiError) throw err; // real rejection — never retry
      console.warn(`[bybit] placeOrder network error, retrying once with orderLinkId=${orderLinkId}:`, (err as Error).message);
      try {
        return await attemptOnce();
      } catch (err2) {
        if (err2 instanceof BybitApiError) throw err2;
        throw new BybitConnectionError(
          `placeOrder failed twice for orderLinkId=${orderLinkId} — order status is UNKNOWN. ` +
          `Check Bybit manually before retrying (do not assume it failed): ${(err2 as Error).message}`,
        );
      }
    }
  }

  async cancelOrder(category: string, symbol: string, orderId: string): Promise<void> {
    await this.withReadRetry("/v5/order/cancel", async () => {
      await this.client.trade.cancelOrder({ category, symbol, orderId });
      return undefined;
    });
  }

  async getOpenOrders(category: string, symbol?: string): Promise<{ list: unknown[] }> {
    return this.withReadRetry("/v5/order/realtime", async () => {
      const res = await this.client.trade.getOpenOrders({ category, symbol });
      return res.result as any;
    });
  }

  async getOrderHistory(category: string, symbol?: string, limit?: number): Promise<{ list: unknown[] }> {
    return this.withReadRetry("/v5/order/history", async () => {
      const res = await this.client.trade.getOrderHistory({ category, symbol, limit });
      return res.result as any;
    });
  }

  async getPositions(category: string, symbol?: string, settleCoin?: string): Promise<{ list: unknown[] }> {
    return this.withReadRetry("/v5/position/list", async () => {
      const res = await this.client.position.getPositionInfo({ category, symbol, settleCoin });
      return res.result as any;
    });
  }

  async getWalletBalance(coin?: string): Promise<{ list: unknown[] }> {
    return this.withReadRetry("/v5/account/wallet-balance", async () => {
      const res = await this.client.account.getWalletBalance({ accountType: "UNIFIED", coin });
      return res.result as any;
    });
  }

  /**
   * Funding fee settlements for a symbol (execType "Funding") — the real,
   * recurring P&L a perpetual position accrues every ~8h that a mid-price
   * ticker never reflects. See specs/live-trading-readiness.md §3.3.
   * `execFee` per Bybit's documented convention: negative = paid, positive =
   * received. (The SDK's ExecDetail type confirms the field names below; the
   * sign convention itself should still be spot-checked against a live
   * testnet run before this is relied on for real accounting — see spec §12.3.)
   */
  async getFundingHistory(category: string, symbol: string, startTime?: number): Promise<{ list: unknown[] }> {
    return this.withReadRetry("/v5/execution/list", async () => {
      const res = await this.client.trade.getTradeHistory({ category: category as any, symbol, execType: "Funding", startTime });
      return res.result as any;
    });
  }

  /**
   * Pin leverage for a symbol. Idempotent by nature (setting to a fixed target
   * value), so it's safe to use the same rate-limited retry-on-ambiguous-error
   * path as a read — unlike order placement, retrying this can't double-execute
   * anything. See specs/live-trading-readiness.md §3.1.
   *
   * Bybit rejects this with a specific error when the requested leverage is
   * already in effect (the expected steady state after the first successful
   * pin) — callers should treat that specific rejection as success rather than
   * failure. This method deliberately does not swallow it itself: which retCode
   * that is has not been verified against live Bybit responses, and guessing
   * wrong here would risk mis-classifying a real failure as success. Callers
   * inspect the thrown error's message for the known "not modified"-style
   * phrasing instead (see BybitConnector.ensureLeverageAndMargin).
   */
  async setLeverage(category: string, symbol: string, leverage: string): Promise<void> {
    return this.withReadRetry("/v5/position/set-leverage", async () => {
      await this.client.position.setLeverage({ category: category as any, symbol, buyLeverage: leverage, sellLeverage: leverage });
    });
  }

  /**
   * Set account-wide margin mode (isolated vs. cross). Unified Trading Accounts
   * set this per-account, not per-symbol — see spec §3.1. Same idempotency
   * reasoning as setLeverage() above.
   */
  async setMarginMode(mode: string): Promise<void> {
    return this.withReadRetry("/v5/account/set-margin-mode", async () => {
      await this.client.account.setMarginMode({ setMarginMode: mode as any });
    });
  }
}
