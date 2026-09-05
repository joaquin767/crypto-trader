import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/risk.ts";
import type { MarketSnapshot } from "../src/market.ts";
import type { Portfolio } from "../src/portfolio.ts";
import type { Config } from "../src/config.ts";

const baseConfig: Config = {
  exchange: "binance",
  apiKey: "a",
  apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: "BTC/USDT",
    price: 40000,
    change24h: 2,
    volume24h: 500,
    timestamp: Date.now(),
    ...overrides,
  };
}

function emptyPortfolio(): Portfolio {
  return { positions: [], totalValueUsd: 0, cashUsd: 10000, dailyTradeCount: 0 };
}

function portfolioWithPosition(): Portfolio {
  return {
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000,
    cashUsd: 10000,
    dailyTradeCount: 0,
  };
}

test("evaluate returns 'sell' on stop-loss trigger", () => {
  const signal = evaluate(snapshot({ price: 37000 }), portfolioWithPosition(), baseConfig);
  assert.equal(signal.type, "sell");
  assert(signal.confidence >= 0.8);
  assert(signal.reason.includes("stop-loss"));
});

test("evaluate returns 'sell' on take-profit trigger", () => {
  const signal = evaluate(snapshot({ price: 45000 }), portfolioWithPosition(), baseConfig);
  assert.equal(signal.type, "sell");
  assert(signal.confidence >= 0.8);
  assert(signal.reason.includes("take-profit"));
});

test("evaluate returns 'hold' when within thresholds", () => {
  const signal = evaluate(snapshot({ price: 40500 }), portfolioWithPosition(), baseConfig);
  assert.equal(signal.type, "hold");
});

test("evaluate returns 'buy' on positive momentum with no position", () => {
  const signal = evaluate(snapshot({ change24h: 5 }), emptyPortfolio(), baseConfig);
  assert.equal(signal.type, "buy");
  assert(signal.confidence > 0.5);
});

test("evaluate returns 'hold' when maxDailyTrades reached", () => {
  const config = { ...baseConfig, maxDailyTrades: 3 };
  const portfolio: Portfolio = { ...emptyPortfolio(), dailyTradeCount: 3 };
  const signal = evaluate(snapshot(), portfolio, config);
  assert.equal(signal.type, "hold");
  assert(signal.reason.includes("maxDailyTrades"));
});

test("evaluate returns 'hold' when position exceeds maxPositionSizeUsd", () => {
  const config = { ...baseConfig, maxPositionSizeUsd: 100 };
  const signal = evaluate(snapshot({ price: 50000, change24h: 5 }), emptyPortfolio(), config);
  assert.equal(signal.type, "hold");
  assert(signal.reason.includes("maxPositionSizeUsd"));
});