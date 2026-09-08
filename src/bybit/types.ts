// Bybit API V5 — TypeScript types, error classes, and endpoint constants.
// Based on official Bybit API V5 documentation.

// ── Config ───────────────────────────────────────────────────────────

export interface BybitConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;         // true = testnet, false = mainnet
  symbols: string[];        // e.g. ["BTCUSDT", "ETHUSDT"] (Bybit format, no /)
  wsPingIntervalMs: number; // default 20000
  maxRetries: number;       // default 5
  /** How often (ms) to poll REST tickers when the WebSocket has exhausted its
   *  reconnect attempts. Defaults to 3000ms. See BybitConnector's REST fallback. */
  restPollIntervalMs?: number;
  /** Place ENTRIES as post-only limit orders (maker fee) instead of market
   *  orders. Closes are never post-only — see config.usePostOnlyEntries. */
  usePostOnlyEntries?: boolean;
  /** How long an unfilled post-only entry may rest before being cancelled.
   *  Defaults to 5000ms. */
  postOnlyTimeoutMs?: number;
}

// ── REST Endpoints ───────────────────────────────────────────────────

export const BYBIT_HOSTS = {
  mainnet: "https://api.bybit.com",
  testnet: "https://api-testnet.bybit.com",
};

export const BYBIT_WS_PUBLIC = {
  mainnet: "wss://stream.bybit.com/v5/public/linear",
  testnet: "wss://stream-testnet.bybit.com/v5/public/linear",
};

export const BYBIT_WS_PRIVATE = {
  mainnet: "wss://stream.bybit.com/v5/private",
  testnet: "wss://stream-testnet.bybit.com/v5/private",
};

// ── Market Data Types ────────────────────────────────────────────────

export interface BybitTicker {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;     // e.g. "0.0158" = +1.58%
  highPrice24h: string;
  lowPrice24h: string;
  volume24h: string;
  turnover24h: string;
  bid1Price: string;
  bid1Size: string;
  ask1Price: string;
  ask1Size: string;
  fundingRate: string;
  openInterest: string;
  markPrice: string;
  indexPrice: string;
}

export interface BybitKline {
  startTime: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  turnover: number;
}

export interface BybitOrderbookEntry {
  price: string;
  size: string;
}

export interface BybitOrderbook {
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
}

// ── Order Types ──────────────────────────────────────────────────────

export interface BybitOrderRequest {
  category: "spot" | "linear" | "inverse";
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit";
  qty: string;
  price?: string;
  timeInForce?: "GTC" | "IOC" | "FOK" | "PostOnly";
  reduceOnly?: boolean;
  orderLinkId?: string;
  takeProfit?: string;
  stopLoss?: string;
  positionIdx?: 0 | 1 | 2;
}

export type BybitOrderStatus =
  | "Created" | "New" | "PartiallyFilled"
  | "Filled" | "Cancelled" | "Rejected" | "Untriggered" | "Triggered" | "Deactivated";

export interface BybitOrderResponse {
  orderId: string;
  orderLinkId: string;
  orderStatus: BybitOrderStatus;
  execType?: string;
  symbol: string;
  side: "Buy" | "Sell";
  price: string;
  qty: string;
  leavesQty: string;
  cumExecQty: string;
  cumExecFee: string;
  cumExecValue?: string;
  avgPrice?: string;
  stopOrderType?: string;
  triggerPrice?: string;
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  createdTime: string;
  updatedTime: string;
}

// ── Position Types ───────────────────────────────────────────────────

export interface BybitPosition {
  symbol: string;
  side: "Buy" | "Sell";
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealisedPnl: string;
  realisedPnl: string;
  liquidationPrice: string;
  leverage: string;
  positionStatus: "Normal" | "Liq" | "Adl";
}

// ── Wallet Types ─────────────────────────────────────────────────────

export interface BybitWalletBalance {
  coin: string;
  walletBalance: string;
  availableBalance: string;
  usdValue: string;
  locked: string;
}

// ── WebSocket Types ──────────────────────────────────────────────────

export type WsTopic =
  | `tickers.${string}`
  | `orderbook.200.${string}`
  | `publicTrade.${string}`
  | `kline.${string}.${string}`
  | `order`
  | `position`
  | `wallet`;

export interface WsAuthMessage {
  op: "auth";
  args: [string, number, string];
}

export interface WsSubscribeMessage {
  op: "subscribe";
  args: string[];
}

export interface WsPingMessage {
  op: "ping";
  req_id?: string;
}

// ── API Response Wrapper ─────────────────────────────────────────────

export interface BybitApiResponse<T = unknown> {
  retCode: number;
  retMsg: string;
  result: T;
  retExtInfo?: Record<string, unknown>;
  time: number;
}

// ── Error Classes (no parameter properties — unsupported by Node strip-types) ──

export class BybitApiError extends Error {
  retCode: number;
  retMsg: string;

  constructor(retCode: number, retMsg: string) {
    super(`Bybit API error [${retCode}]: ${retMsg}`);
    this.name = "BybitApiError";
    this.retCode = retCode;
    this.retMsg = retMsg;
  }
}

export class BybitAuthError extends BybitApiError {
  constructor(retCode: number, retMsg: string) {
    super(retCode, retMsg);
    this.name = "BybitAuthError";
  }
}

export class BybitRateLimitError extends BybitApiError {
  constructor(retCode: number, retMsg: string) {
    super(retCode, retMsg);
    this.name = "BybitRateLimitError";
  }
}

export class BybitInsufficientBalanceError extends BybitApiError {
  constructor(retCode: number, retMsg: string) {
    super(retCode, retMsg);
    this.name = "BybitInsufficientBalanceError";
  }
}

export class BybitInvalidQtyError extends BybitApiError {
  constructor(retCode: number, retMsg: string) {
    super(retCode, retMsg);
    this.name = "BybitInvalidQtyError";
  }
}

export class BybitConnectionError extends Error {
  constructor(msg: string) {
    super(`Bybit connection error: ${msg}`);
    this.name = "BybitConnectionError";
  }
}

export class BybitConfigError extends Error {
  constructor(msg: string) {
    super(`Bybit config error: ${msg}`);
    this.name = "BybitConfigError";
  }
}

/**
 * Account-level errors that require trading to stop immediately — the account is
 * banned, restricted, or otherwise cannot trade regardless of retrying.
 * See docs/bybit-integration spec §9D — these are NOT recoverable by falling back
 * to paper mode and continuing; the caller must halt and notify the user.
 */
export class BybitFatalError extends BybitApiError {
  constructor(retCode: number, retMsg: string) {
    super(retCode, retMsg);
    this.name = "BybitFatalError";
  }
}

/**
 * Thrown when an order was accepted by Bybit but the response we can see does not
 * contain a parseable fill (NaN/empty qty, price, or fee) — e.g. a market order
 * whose execution report hadn't landed yet when the REST ack came back.
 * Callers must NOT synthesize a trade result from this — doing so previously
 * corrupted portfolio.cashUsd into NaN permanently. Instead, poll for the real
 * fill (see BybitConnector.placeOrder) or surface this for manual reconciliation.
 */
export class BybitFillUncertainError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BybitFillUncertainError";
  }
}

// ── Error Classification ─────────────────────────────────────────────

/**
 * Classify a Bybit API error code into the appropriate error class.
 * See https://bybit-exchange.github.io/docs/v5/error for full list.
 */
export function classifyError(retCode: number, retMsg: string): BybitApiError {
  switch (retCode) {
    case 10003:
    case 10004:
      return new BybitAuthError(retCode, retMsg);
    case 10006:
      return new BybitRateLimitError(retCode, retMsg);
    case 110007:
      return new BybitInsufficientBalanceError(retCode, retMsg);
    // Account-level bans/restrictions — never safe to retry or silently paper-fallback.
    // See anti-ban spec §9D: 10005 permission denied, 10008 common banned,
    // 10009 region restricted, 10010 IP not whitelisted, 10027 transactions banned,
    // 10028 not a UTA account.
    case 10005:
    case 10008:
    case 10009:
    case 10010:
    case 10027:
    case 10028:
      return new BybitFatalError(retCode, retMsg);
    default:
      // Check for known error patterns in retMsg
      if (retMsg.includes("exceeds minimum limit")) {
        return new BybitInvalidQtyError(retCode, retMsg);
      }
      return new BybitApiError(retCode, retMsg);
  }
}

// ── Endpoint Rate Limits (from official docs, 50% safety margin) ─────
// These are OUR conservative limits, not Bybit's.

export const ENDPOINT_LIMITS: Record<string, { maxPerSecond: number; maxBurst: number }> = {
  "/v5/market/tickers": { maxPerSecond: 10, maxBurst: 20 },
  "/v5/market/kline": { maxPerSecond: 10, maxBurst: 20 },
  "/v5/market/orderbook": { maxPerSecond: 10, maxBurst: 20 },
  "/v5/market/instruments": { maxPerSecond: 10, maxBurst: 20 },
  "/v5/order/create": { maxPerSecond: 2, maxBurst: 5 },
  "/v5/order/amend": { maxPerSecond: 2, maxBurst: 5 },
  "/v5/order/cancel": { maxPerSecond: 2, maxBurst: 5 },
  "/v5/order/realtime": { maxPerSecond: 5, maxBurst: 10 },
  "/v5/order/history": { maxPerSecond: 5, maxBurst: 10 },
  "/v5/position/list": { maxPerSecond: 5, maxBurst: 10 },
  "/v5/account/wallet-balance": { maxPerSecond: 5, maxBurst: 10 },
  "/v5/position/set-leverage": { maxPerSecond: 2, maxBurst: 5 },
  "/v5/account/set-margin-mode": { maxPerSecond: 2, maxBurst: 5 },
  "/v5/execution/list": { maxPerSecond: 5, maxBurst: 10 },
};

export function getEndpointLimit(path: string): { maxPerSecond: number; maxBurst: number } {
  // Match the most specific path
  const key = Object.keys(ENDPOINT_LIMITS).find(k => path.startsWith(k));
  return key ? ENDPOINT_LIMITS[key]! : { maxPerSecond: 5, maxBurst: 10 };
}