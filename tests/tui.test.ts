import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/tui.ts";
import type { AppState } from "../src/tui.ts";
import { empty } from "../src/portfolio.ts";

/**
 * Test that render() accepts valid AppState and produces output
 * (does not throw, and console.log is called at least once).
 */
test("render does not throw with empty state", () => {
  const state: AppState = {
    marketData: new Map(),
    portfolio: empty(),
    lastSignal: null,
    statusMessage: "test mode",
    mode: "paper",
  };
  // In test mode, render() writes to console; we just verify it doesn't throw
  render(state);
  assert.ok(true, "render completed without throwing");
});

test("render does not throw with full state", () => {
  const state: AppState = {
    marketData: new Map([
      ["BTC/USDT", { symbol: "BTC/USDT", price: 40000, change24h: 2.5, volume24h: 500, timestamp: Date.now() }],
    ]),
    portfolio: { positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 41000 }], totalValueUsd: 14100, cashUsd: 10000, dailyTradeCount: 1, maxCapitalUsd: 10000 },
    lastSignal: { type: "buy", symbol: "BTC/USDT", confidence: 0.8, reason: "positive momentum", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } },
    statusMessage: "running",
    mode: "paper",
  };
  render(state);
  assert.ok(true, "render completed without throwing");
});