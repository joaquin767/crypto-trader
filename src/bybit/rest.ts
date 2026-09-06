// Bybit REST API V5 client with HMAC-SHA256 authentication,
// per-endpoint token bucket rate limiting, and error classification.

import { createHmac } from "node:crypto";
import {
  type BybitConfig,
  type BybitApiResponse,
  type BybitTicker,
  type BybitKline,
  type BybitOrderbook,
  type BybitOrderRequest,
  type BybitOrderResponse,
  type BybitPosition,
  type BybitWalletBalance,
  BYBIT_HOSTS,
  classifyError,
  getEndpointLimit,
  BybitApiError,
  BybitConnectionError,
  BybitConfigError,
} from "./types.ts";

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number; // tokens per second
}

export interface RestClientOptions {
  timeoutMs?: number;
  recvWindowMs?: number;
}

export class RestClient {
  private config: BybitConfig;
  private host: string;
  private buckets: Map<string, TokenBucket> = new Map();
  private timeoutMs: number;
  private recvWindowMs: number;
  private serverTimeDiff = 0; // ms difference between local and server time
  private lastTimeSync = 0;

  constructor(config: BybitConfig, opts: RestClientOptions = {}) {
    this.config = config;
    this.host = config.testnet ? BYBIT_HOSTS.testnet : BYBIT_HOSTS.mainnet;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.recvWindowMs = opts.recvWindowMs ?? 5000;

    if (!config.apiKey || !config.apiSecret) {
      throw new BybitConfigError("API key and secret are required");
    }
  }

  // ── Authentication ─────────────────────────────────────────────────

  /**
   * Sync local clock with Bybit server time.
   * Must be called on startup and periodically (every hour).
   * Auth will fail if clock skew > 30s (retCode 10002).
   */
  async syncTime(): Promise<number> {
    const start = Date.now();
    const res = await fetch(`${this.host}/v5/market/time`, { signal: AbortSignal.timeout(5000) });
    const data: BybitApiResponse<{ timeSecond: string; timeNano: string }> = await res.json();
    const end = Date.now();
    const rtt = end - start;
    const serverTime = Number.parseInt(data.result.timeSecond) * 1000;
    this.serverTimeDiff = serverTime - (start + rtt / 2);
    this.lastTimeSync = Date.now();
    return this.serverTimeDiff;
  }

  /** Get the current timestamp adjusted for server time difference. */
  private getTimestamp(): number {
    return Date.now() + this.serverTimeDiff;
  }

  /**
   * Generate HMAC-SHA256 signature for a request.
   * Format:
   * - GET: HMAC-SHA256(api_secret, timestamp + api_key + recv_window + query_string)
   * - POST: HMAC-SHA256(api_secret, timestamp + api_key + recv_window + body_json)
   */
  private sign(method: string, path: string, body?: string): { timestamp: number; signature: string } {
    const timestamp = this.getTimestamp();
    const recvWindow = this.recvWindowMs;

    // Bybit V5 signature uses query parameters for GET and body for POST/PUT
    let paramStr = "";
    if (method === "GET") {
      const parts = path.split("?");
      paramStr = parts[1] || "";
    } else {
      paramStr = body ?? "";
    }

    const payload = `${timestamp}${this.config.apiKey}${recvWindow}${paramStr}`;
    const signature = createHmac("sha256", this.config.apiSecret)
      .update(payload)
      .digest("hex");

    return { timestamp, signature };
  }

  // ── Rate Limiting ──────────────────────────────────────────────────

  private getBucket(path: string): TokenBucket {
    let bucket = this.buckets.get(path);
    if (!bucket) {
      const limits = getEndpointLimit(path);
      bucket = {
        tokens: limits.maxBurst,
        lastRefill: Date.now(),
        maxTokens: limits.maxBurst,
        refillRate: limits.maxPerSecond,
      };
      this.buckets.set(path, bucket);
    }
    return bucket;
  }

  /**
   * Wait for a token from the rate limiter.
   * Blocks until a token is available (queues, never throws for rate limits).
   */
  private async waitForToken(path: string): Promise<void> {
    const bucket = this.getBucket(path);
    while (true) {
      const now = Date.now();
      const elapsed = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
      bucket.lastRefill = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }

      // Wait for the next token (at least 50ms to avoid busy-wait)
      await new Promise(r => setTimeout(r, 50));
    }
  }

  /**
   * Update token bucket from response headers (X-Bapi-Limit-Status).
   * This syncs our local bucket with the server's actual state.
   */
  private syncFromHeaders(path: string, headers: Headers): void {
    const remaining = headers.get("X-Bapi-Limit-Status");
    const limit = headers.get("X-Bapi-Limit");
    const resetTime = headers.get("X-Bapi-Limit-Reset-Timestamp");

    if (remaining !== null && limit !== null) {
      const bucket = this.getBucket(path);
      bucket.tokens = Math.min(bucket.maxTokens, Number.parseInt(remaining));
      // If we're below 20% of the limit, reduce our rate
      const limitNum = Number.parseInt(limit);
      if (Number.parseInt(remaining) < limitNum * 0.2) {
        bucket.refillRate = bucket.refillRate * 0.5; // cut in half
      }
    }
  }

  // ── Core Request Method ────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    retries = 0,
  ): Promise<T> {
    const fullUrl = `${this.host}${path}`;

    // Rate limit: wait for a token
    await this.waitForToken(path);

    // Build headers
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const { timestamp, signature } = this.sign(method, path, bodyStr);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": this.config.apiKey,
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": String(this.recvWindowMs),
    };

    try {
      const response = await fetch(fullUrl, {
        method,
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Sync rate limits from response headers
      this.syncFromHeaders(path, response.headers);

      // Handle HTTP-level errors
      if (response.status === 403) {
        if (retries < 2) {
          // IP banned, wait 30s before retrying
          await new Promise(r => setTimeout(r, 30000));
          return this.request<T>(method, path, body, retries + 1);
        }
        throw new BybitConnectionError(`IP banned (HTTP 403). Waited 30s. Reduce request rate.`);
      }

      if (response.status === 429) {
        // System-level frequency protection
        await new Promise(r => setTimeout(r, 5000));
        return this.request<T>(method, path, body, retries + 1);
      }

      const data: BybitApiResponse<T> = await response.json();

      // Handle API-level errors
      if (data.retCode !== 0) {
        if (data.retCode === 10006) {
          // Rate limited — backoff heavily
          await new Promise(r => setTimeout(r, 2000));
          return this.request<T>(method, path, body, retries + 1);
        }

        const error = classifyError(data.retCode, data.retMsg);
        throw error;
      }

      return data.result;
    } catch (err) {
      if (err instanceof BybitApiError) throw err;
      if (err instanceof BybitConnectionError) throw err;

      // Retry on network errors
      if (retries < 2) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
        return this.request<T>(method, path, body, retries + 1);
      }

      throw new BybitConnectionError(
        `Request failed after ${retries + 1} retries: ${(err as Error).message}`,
      );
    }
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  // ── Public Endpoints (no auth beyond key) ──────────────────────────

  /** Get the server time and sync local clock. */
  async getServerTime(): Promise<number> {
    const data = await this.get<{ timeSecond: string; timeNano: string }>("/v5/market/time");
    return Number.parseInt(data.timeSecond) * 1000;
  }

  /** Get tickers for one or all symbols. */
  async getTickers(category: string, symbol?: string): Promise<{ category: string; list: BybitTicker[] }> {
    let path = `/v5/market/tickers?category=${category}`;
    if (symbol) path += `&symbol=${symbol}`;
    return this.get<{ category: string; list: BybitTicker[] }>(path);
  }

  /** Get kline/candlestick data. */
  async getKline(
    category: string,
    symbol: string,
    interval: string,
    start?: number,
    end?: number,
    limit?: number,
  ): Promise<{ category: string; symbol: string; list: string[][] }> {
    let path = `/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}`;
    if (start) path += `&start=${start}`;
    if (end) path += `&end=${end}`;
    if (limit) path += `&limit=${limit}`;
    return this.get<{ category: string; symbol: string; list: string[][] }>(path);
  }

  /** Get orderbook snapshot. */
  async getOrderbook(category: string, symbol: string, level = 25): Promise<BybitOrderbook> {
    const data = await this.get<{
      category: string; symbol: string; bids: [string, string][]; asks: [string, string][];
    }>(`/v5/market/orderbook?category=${category}&symbol=${symbol}&limit=${level}`);
    return { bids: data.bids, asks: data.asks, timestamp: Date.now() };
  }

  /** Get recent public trades. */
  async getRecentTrades(
    category: string, symbol: string, limit?: number,
  ): Promise<{ category: string; list: unknown[] }> {
    let path = `/v5/market/recent-trade?category=${category}&symbol=${symbol}`;
    if (limit) path += `&limit=${limit}`;
    return this.get<{ category: string; list: unknown[] }>(path);
  }

  // ── Authenticated Trading Endpoints ────────────────────────────────

  /** Place an order. */
  async placeOrder(order: BybitOrderRequest): Promise<BybitOrderResponse> {
    return this.post<BybitOrderResponse>("/v5/order/create", order as unknown as Record<string, unknown>);
  }

  /** Cancel an order. */
  async cancelOrder(category: string, symbol: string, orderId: string): Promise<void> {
    await this.post("/v5/order/cancel", { category, symbol, orderId });
  }

  /** Get open orders. */
  async getOpenOrders(category: string, symbol?: string): Promise<{ list: BybitOrderResponse[] }> {
    let path = `/v5/order/realtime?category=${category}`;
    if (symbol) path += `&symbol=${symbol}`;
    return this.get<{ list: BybitOrderResponse[] }>(path);
  }

  /** Get order history (up to 2 years). */
  async getOrderHistory(
    category: string, symbol?: string, limit?: number,
  ): Promise<{ list: BybitOrderResponse[] }> {
    let path = `/v5/order/history?category=${category}`;
    if (symbol) path += `&symbol=${symbol}`;
    if (limit) path += `&limit=${limit}`;
    return this.get<{ list: BybitOrderResponse[] }>(path);
  }

  /** Get positions. */
  async getPositions(
    category: string, symbol?: string,
  ): Promise<{ list: BybitPosition[] }> {
    let path = `/v5/position/list?category=${category}`;
    if (symbol) path += `&symbol=${symbol}`;
    return this.get<{ list: BybitPosition[] }>(path);
  }

  /** Get wallet balance. */
  async getWalletBalance(coin?: string): Promise<{ list: BybitWalletBalance[] }> {
    let path = "/v5/account/wallet-balance?accountType=UNIFIED";
    if (coin) path += `&coin=${coin}`;
    return this.get<{ list: BybitWalletBalance[] }>(path);
  }
}