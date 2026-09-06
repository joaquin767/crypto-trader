import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyError, BybitAuthError, BybitRateLimitError, BybitApiError,
  BybitConnectionError, BybitInsufficientBalanceError, BybitInvalidQtyError,
  BybitConfigError, getEndpointLimit,
} from "../src/bybit/types.ts";
import {
  tickerToMarketSnapshot,
  orderResponseToTradeResult,
  appSymbolToBybit,
  bybitSymbolToApp,
  bybitPositionToPosition,
  walletToTotalUsd,
  walletAvailableBalance,
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

// ── Additional Adapter Tests ─────────────────────────────────────────

import type { BybitWalletBalance } from "../src/bybit/types.ts";

test("bybitPositionToPosition converts Bybit position", () => {
  const pos = {
    symbol: "BTCUSDT",
    side: "Buy" as const,
    size: "0.5",
    entryPrice: "40000",
    markPrice: "41000",
    unrealisedPnl: "500",
    realisedPnl: "100",
    liquidationPrice: "35000",
    leverage: "1",
    positionStatus: "Normal" as const,
  };
  const result = bybitPositionToPosition(pos);
  assert.equal(result.symbol, "BTC/USDT");
  assert.equal(result.quantity, 0.5);
  assert.equal(result.entryPrice, 40000);
  assert.equal(result.currentPrice, 41000);
});

test("bybitPositionToPosition handles zero values", () => {
  const pos = { symbol: "ETHUSDT", side: "Sell" as const, size: "0", entryPrice: "0", markPrice: "0", unrealisedPnl: "0", realisedPnl: "0", liquidationPrice: "0", leverage: "1", positionStatus: "Normal" as const };
  const result = bybitPositionToPosition(pos);
  assert.equal(result.quantity, 0);
  assert.equal(result.entryPrice, 0);
  assert.equal(result.currentPrice, 0);
});

test("walletToTotalUsd sums wallet balances", () => {
  const wallets: BybitWalletBalance[] = [
    { coin: "USDT", walletBalance: "1000", availableBalance: "800", usdValue: "1000", locked: "200" },
    { coin: "BTC", walletBalance: "0.1", availableBalance: "0.1", usdValue: "4100", locked: "0" },
  ];
  const total = walletToTotalUsd(wallets);
  assert.equal(total, 5100);
});

test("walletToTotalUsd handles empty wallets", () => {
  assert.equal(walletToTotalUsd([]), 0);
});

test("walletToTotalUsd handles missing usdValue", () => {
  const wallets: BybitWalletBalance[] = [
    { coin: "USDT", walletBalance: "1000", availableBalance: "800", usdValue: "", locked: "200" },
  ];
  const total = walletToTotalUsd(wallets);
  assert.equal(total, 0);
});

test("walletAvailableBalance returns balance for matching coin", () => {
  const wallets: BybitWalletBalance[] = [
    { coin: "USDT", walletBalance: "1000", availableBalance: "800", usdValue: "1000", locked: "200" },
  ];
  assert.equal(walletAvailableBalance(wallets, "USDT"), 800);
});

test("walletAvailableBalance returns 0 for missing coin", () => {
  const wallets: BybitWalletBalance[] = [
    { coin: "USDT", walletBalance: "1000", availableBalance: "800", usdValue: "1000", locked: "200" },
  ];
  assert.equal(walletAvailableBalance(wallets, "BTC"), 0);
});

test("walletAvailableBalance returns 0 for empty wallets", () => {
  assert.equal(walletAvailableBalance([], "USDT"), 0);
});

// ── Delta Merging Tests ──────────────────────────────────────────────

test("tickerToMarketSnapshot merges with previous snapshot", () => {
  const delta = { symbol: "BTCUSDT", lastPrice: "42000" };
  const previous = { symbol: "BTC/USDT", price: 40000, change24h: 2.5, volume24h: 500, timestamp: Date.now() };
  const result = tickerToMarketSnapshot(delta, previous);
  assert.equal(result.price, 42000); // from delta
  assert.equal(result.change24h, 2.5); // from previous (not in delta)
  assert.equal(result.volume24h, 500); // from previous (not in delta)
});

test("tickerToMarketSnapshot handles empty delta gracefully", () => {
  const delta = { symbol: "BTCUSDT" };
  const previous = { symbol: "BTC/USDT", price: 40000, change24h: 2.5, volume24h: 500, timestamp: Date.now() };
  const result = tickerToMarketSnapshot(delta, previous);
  assert.equal(result.price, 40000); // from previous
  assert.equal(result.change24h, 2.5); // from previous
  assert.equal(result.volume24h, 500); // from previous
});

test("tickerToMarketSnapshot handles NaN in delta gracefully", () => {
  const delta = { symbol: "BTCUSDT", lastPrice: "invalid", price24hPcnt: "bad", volume24h: "nope" };
  const previous = { symbol: "BTC/USDT", price: 40000, change24h: 2.5, volume24h: 500, timestamp: Date.now() };
  const result = tickerToMarketSnapshot(delta, previous);
  assert.equal(result.price, 40000); // from previous (delta was NaN)
  assert.equal(result.change24h, 2.5); // from previous
  assert.equal(result.volume24h, 500); // from previous
});

test("tickerToMarketSnapshot defaults to 0 when no previous snapshot", () => {
  const delta = { symbol: "BTCUSDT", lastPrice: "invalid" };
  const result = tickerToMarketSnapshot(delta);
  assert.equal(result.price, 0); // 0 default
  assert.equal(result.symbol, "BTC/USDT");
});

// ── BybitInsufficientBalanceError Tests ──────────────────────────────

test("classifyError returns BybitInsufficientBalanceError for 110007", () => {
  const err = classifyError(110007, "ab not enough for new order");
  assert(err instanceof BybitInsufficientBalanceError);
});

test("classifyError returns BybitInvalidQtyError for minimum limit", () => {
  const err = classifyError(10001, "The number of contracts exceeds minimum limit allowed");
  assert(err instanceof BybitInvalidQtyError);
});

// ── BybitConfigError Tests ───────────────────────────────────────────

test("BybitConfigError has correct name and message", () => {
  const err = new BybitConfigError("Missing API key");
  assert.equal(err.name, "BybitConfigError");
  assert(err.message.includes("Missing API key"));
});

// ── Error Class Error Properties Tests ───────────────────────────────

test("BybitApiError stores retCode and retMsg", () => {
  const err = new BybitApiError(10001, "Some error");
  assert.equal(err.retCode, 10001);
  assert.equal(err.retMsg, "Some error");
});

test("BybitAuthError inherits from BybitApiError", () => {
  const err = new BybitAuthError(10003, "Invalid key");
  assert(err instanceof BybitApiError);
  assert.equal(err.retCode, 10003);
});

test("BybitRateLimitError inherits from BybitApiError", () => {
  const err = new BybitRateLimitError(10006, "Rate limit");
  assert(err instanceof BybitApiError);
  assert.equal(err.retCode, 10006);
});
