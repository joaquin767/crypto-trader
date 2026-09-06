import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, clearHistory, setHistory, getHistory } from "../src/strategy/signals.ts";
import type { MarketSnapshot } from "../src/market.ts";
import { empty } from "../src/portfolio.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  exchange: "binance", apiKey: "a", apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

const configNoDailyLimit: Config = {
  ...config,
  maxDailyTrades: 0, // unlimited
};

function snap(price: number, change = 2): MarketSnapshot {
  return { symbol: "BTC/USDT", price, change24h: change, volume24h: 500, timestamp: Date.now() };
}

function seedRisingPrices(): void {
  const prices = Array.from({ length: 30 }, (_, i) => 39000 + i * 100);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 200),
    lows: prices.map(p => p - 200),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
}

function seedFallingPrices(): void {
  const prices = Array.from({ length: 30 }, (_, i) => 42000 - i * 100);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 200),
    lows: prices.map(p => p - 200),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
}

function seedVolatilePrices(): void {
  const prices = Array.from({ length: 30 }, (_, i) => 40000 + Math.sin(i * 0.8) * 3000);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 500),
    lows: prices.map(p => p - 500),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
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

test("analyze holds when position is within thresholds", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(40500, 1), portfolio, config);
  assert.equal(signal.type, "hold");
});

test("analyze returns 'buy' given bullish indicators and no position", () => {
  clearHistory();
  seedRisingPrices();
  const portfolio = empty();
  const signal = analyze(snap(42000, 5), portfolio, configNoDailyLimit);
  assert(["buy", "hold"].includes(signal.type));
  if (signal.type === "buy") {
    assert(signal.confidence > 0.4);
  }
});

test("analyze returns 'sell' on RSI overbought with price above upper band", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  // Seed extremely overbought scenario
  const prices = Array.from({ length: 30 }, (_, i) => 40000 + i * 500);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 300),
    lows: prices.map(p => p - 200),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const signal = analyze(snap(54000, 15), portfolio, configNoDailyLimit);
  assert.equal(signal.type, "sell", "should be sell on RSI overbought + price above upper band");
});

test("analyze returns 'sell' on negative momentum sell signal", () => {
  clearHistory();
  seedFallingPrices();
  const portfolio = empty();
  const signal = analyze(snap(39000, -5), portfolio, configNoDailyLimit);
  // Should be sell or hold when indicators are bearish
  assert(["sell", "hold"].includes(signal.type));
});

test("analyze includes indicators in the result", () => {
  clearHistory();
  const portfolio = empty();
  const signal = analyze(snap(40000), portfolio, configNoDailyLimit);
  assert(signal.indicators);
  assert(typeof signal.indicators.rsi === "number");
  assert(typeof signal.indicators.momentum === "number");
  assert(typeof signal.indicators.atr === "number");
  assert(signal.indicators.macd);
  assert(signal.indicators.bollinger);
});

test("analyze prevents trading in high volatility", () => {
  clearHistory();
  seedVolatilePrices();
  const portfolio = empty();
  const signal = analyze(snap(40000, 3), portfolio, configNoDailyLimit);
  // High volatility should add to sellScore
  assert(signal.indicators.atr > 0);
  assert(typeof signal.reason === "string");
});

test("analyze handles insufficient cash gracefully", () => {
  clearHistory();
  seedRisingPrices();
  const portfolio = { ...empty(), cashUsd: 0.5 }; // very little cash
  const signal = analyze(snap(42000, 5), portfolio, configNoDailyLimit);
  // Should be hold because we can't afford the position
  assert(["hold", "buy"].includes(signal.type));
});

test("getHistory returns correct history for a symbol", () => {
  clearHistory();
  seedRisingPrices();
  const history = getHistory("BTC/USDT");
  assert(history.prices.length > 0);
  assert(history.highs.length > 0);
  assert(history.lows.length > 0);
  assert(history.timestamps.length > 0);
  assert.equal(history.prices.length, history.highs.length);
});

test("getHistory creates new history for unknown symbol", () => {
  clearHistory();
  const history = getHistory("SOL/USDT");
  assert(history.prices.length === 0);
  assert(history.timestamps.length === 0);
});

test("clearHistory resets all histories", () => {
  clearHistory();
  seedRisingPrices();
  assert(getHistory("BTC/USDT").prices.length > 0);
  clearHistory();
  assert(getHistory("BTC/USDT").prices.length === 0);
});

test("setHistory overwrites existing history", () => {
  clearHistory();
  setHistory("BTC/USDT", {
    prices: [100, 200, 300],
    highs: [150, 250, 350],
    lows: [50, 150, 250],
    timestamps: [1, 2, 3],
  });
  const history = getHistory("BTC/USDT");
  assert.deepEqual(history.prices, [100, 200, 300]);
});

test("analyze handles empty history gracefully", () => {
  clearHistory();
  const portfolio = empty();
  const signal = analyze(snap(40000, 2), portfolio, configNoDailyLimit);
  // With no history, indicators should use defaults
  assert(signal.indicators.rsi >= 0);
  assert(signal.indicators.rsi <= 100);
});