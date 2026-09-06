import { test } from "node:test";
import assert from "node:assert/strict";
import { RestClient } from "../src/bybit/rest.ts";
import { WsClient } from "../src/bybit/ws.ts";
import {
  classifyError, BybitAuthError, BybitRateLimitError, BybitApiError,
  BybitConnectionError, getEndpointLimit,
} from "../src/bybit/types.ts";
import {
  tickerToMarketSnapshot,
  orderResponseToTradeResult,
  appSymbolToBybit,
  bybitSymbolToApp,
} from "../src/bybit/adapters.ts";

// ── Mock Data ────────────────────────────────────────────────────────

const mockTicker = {
  symbol: "BTCUSDT",
  lastPrice: "41398.50",
  price24hPcnt: "0.0462",
  highPrice24h: "42500.00",
  lowPrice24h: "39000.00",
  volume24h: "12345.67",
  turnover24h: "512345678.90",
  bid1Price: "41398.00",
  bid1Size: "12.5",
  ask1Price: "41399.00",
  ask1Size: "8.3",
  fundingRate: "0.0001",
  openInterest: "50000",
  markPrice: "41398.50",
  indexPrice: "41395.00",
};

const mockOrderResponse = {
  orderId: "abc123",
  orderLinkId: "test-link-1",
  orderStatus: "Filled" as const,
  symbol: "BTCUSDT",
  side: "Buy" as const,
  price: "40000.00",
  qty: "1",
  leavesQty: "0",
  cumExecQty: "1",
  cumExecFee: "0.40",
  cumExecValue: "40000.00",
  avgPrice: "40001.50",
  createdTime: String(Date.now()),
  updatedTime: String(Date.now()),
};

// ── Error Classification Tests ───────────────────────────────────────

test("classifyError returns BybitAuthError for code 10003", () => {
  const err = classifyError(10003, "Invalid API key");
  assert(err instanceof BybitAuthError);
  assert(err.message.includes("Invalid API key"));
});

test("classifyError returns BybitAuthError for code 10004", () => {
  const err = classifyError(10004, "Invalid sign");
  assert(err instanceof BybitAuthError);
});

test("classifyError returns BybitRateLimitError for code 10006", () => {
  const err = classifyError(10006, "Too many visits");
  assert(err instanceof BybitRateLimitError);
});

test("classifyError returns generic BybitApiError for unknown codes", () => {
  const err = classifyError(99999, "Something else");
  assert(err instanceof BybitApiError);
  assert(!(err instanceof BybitAuthError));
  assert(!(err instanceof BybitRateLimitError));
});

// ── Endpoint Limits Tests ────────────────────────────────────────────

test("getEndpointLimit returns correct limits for known endpoints", () => {
  const limits = getEndpointLimit("/v5/order/create");
  assert.equal(limits.maxPerSecond, 2);
  assert.equal(limits.maxBurst, 5);
});

test("getEndpointLimit returns default limits for unknown endpoints", () => {
  const limits = getEndpointLimit("/v5/some/unknown/endpoint");
  assert.equal(limits.maxPerSecond, 5);
  assert.equal(limits.maxBurst, 10);
});

test("getEndpointLimit matches prefix", () => {
  const limits = getEndpointLimit("/v5/order/create?symbol=BTCUSDT");
  assert.equal(limits.maxPerSecond, 2);
});

// ── Adapter Tests ────────────────────────────────────────────────────

test("tickerToMarketSnapshot converts Bybit ticker to MarketSnapshot", () => {
  const snapshot = tickerToMarketSnapshot(mockTicker);
  assert.equal(snapshot.symbol, "BTC/USDT");
  assert.equal(snapshot.price, 41398.50);
  assert.equal(snapshot.change24h, 4.62); // 0.0462 * 100
  assert.equal(snapshot.volume24h, 12345.67);
});

test("orderResponseToTradeResult converts filled buy order", () => {
  const result = orderResponseToTradeResult(mockOrderResponse);
  assert.equal(result.symbol, "BTC/USDT");
  assert.equal(result.side, "buy");
  assert.equal(result.quantity, 1);
  assert(result.price > 0);
  assert(result.fee > 0);
});

test("orderResponseToTradeResult converts filled sell order", () => {
  const sellOrder = { ...mockOrderResponse, side: "Sell" as const, avgPrice: "42000.00" };
  const result = orderResponseToTradeResult(sellOrder);
  assert.equal(result.side, "sell");
  assert.equal(result.price, 42000);
});

// ── Symbol Format Conversion Tests ───────────────────────────────────

test("appSymbolToBybit converts with / separator", () => {
  assert.equal(appSymbolToBybit("BTC/USDT"), "BTCUSDT");
  assert.equal(appSymbolToBybit("ETH/USDC"), "ETHUSDC");
  assert.equal(appSymbolToBybit("SOL/USD"), "SOLUSD");
});

test("bybitSymbolToApp adds / separator for USDT", () => {
  assert.equal(bybitSymbolToApp("BTCUSDT"), "BTC/USDT");
  assert.equal(bybitSymbolToApp("ETHUSDT"), "ETH/USDT");
});

test("bybitSymbolToApp adds / separator for USDC", () => {
  assert.equal(bybitSymbolToApp("BTCUSDC"), "BTC/USDC");
});

test("bybitSymbolToApp adds / separator for USD", () => {
  assert.equal(bybitSymbolToApp("BTCUSD"), "BTC/USD");
});

test("bybitSymbolToApp returns as-is for unknown format", () => {
  assert.equal(bybitSymbolToApp("BTC"), "BTC");
});

// ── Connection Error Tests ───────────────────────────────────────────

test("BybitConnectionError has correct name and message", () => {
  const err = new BybitConnectionError("Connection refused");
  assert.equal(err.name, "BybitConnectionError");
  assert(err.message.includes("Connection refused"));
});

// ── RestClient Constructor Tests ─────────────────────────────────────

test("RestClient constructor requires API key and secret", () => {
  assert.throws(() => {
    new RestClient({ apiKey: "", apiSecret: "", testnet: true, symbols: [], wsPingIntervalMs: 20000, maxRetries: 5 });
  }, /API key and secret are required/);
});

test("RestClient constructor accepts valid config", () => {
  const client = new RestClient({ apiKey: "test", apiSecret: "test", testnet: true, symbols: ["BTCUSDT"], wsPingIntervalMs: 20000, maxRetries: 5 });
  assert(client instanceof RestClient);
});