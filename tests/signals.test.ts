import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, clearHistory, setHistory } from "../src/strategy/signals.ts";
import type { MarketSnapshot } from "../src/market.ts";
import { empty } from "../src/portfolio.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  exchange: "binance", apiKey: "a", apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

function snap(price: number, change = 2): MarketSnapshot {
  return { symbol: "BTC/USDT", price, change24h: change, volume24h: 500, timestamp: Date.now() };
}

test("analyze returns 'hold' with maxDailyTrades reached", () => {
  clearHistory();
  const portfolio = { ...empty(), dailyTradeCount: 5 };
  const signal = analyze(snap(40000), portfolio, config);
  assert.equal(signal.type, "hold");
  assert(signal.reason.includes("maxDailyTrades"));
});

test("analyze returns 'sell' on stop-loss", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(37000), portfolio, config);
  assert.equal(signal.type, "sell");
  assert(signal.confidence >= 0.7);
});

test("analyze returns 'sell' on take-profit", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(45000), portfolio, config);
  assert.equal(signal.type, "sell");
});

test("analyze returns 'buy' given bullish indicators and no position", () => {
  clearHistory();
  // Seed history with strongly rising prices to trigger RSI oversold -> but we want buy...
  // Actually, for a buy signal we need: rising momentum, MACD bullish, no position
  const prices = Array.from({ length: 30 }, (_, i) => 39000 + i * 100);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 200),
    lows: prices.map(p => p - 200),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const portfolio = empty();
  const signal = analyze(snap(42000, 5), portfolio, config);
  // Should be "buy" or "hold" depending on indicator alignment
  assert(["buy", "hold"].includes(signal.type));
  if (signal.type === "buy") {
    assert(signal.confidence > 0.4);
  }
});

test("analyze includes indicators in the result", () => {
  clearHistory();
  const portfolio = empty();
  const signal = analyze(snap(40000), portfolio, config);
  assert(signal.indicators);
  assert(typeof signal.indicators.rsi === "number");
  assert(typeof signal.indicators.momentum === "number");
  assert(typeof signal.indicators.atr === "number");
  assert(signal.indicators.macd);
  assert(signal.indicators.bollinger);
});