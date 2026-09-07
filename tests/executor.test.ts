import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.ts";
import type { TradeSignal } from "../src/strategy/signals.ts";
import type { Config } from "../src/config.ts";
import type { Portfolio } from "../src/portfolio.ts";
import type { MarketSnapshot } from "../src/market.ts";

const config: Config = {
  exchange: "binance",
  apiKey: "a",
  apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

const indicators = { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 };

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return { positions: [], totalValueUsd: 1000, cashUsd: 1000, dailyTradeCount: 0, maxCapitalUsd: 1000, ...overrides };
}

function makeSnapshot(symbol: string, price: number): MarketSnapshot {
  return { symbol, price, change24h: 0, volume24h: 0, timestamp: Date.now() };
}

test("execute 'hold' returns a hold result", async () => {
  const signal: TradeSignal = { type: "hold", symbol: "BTC/USDT", confidence: 1, reason: "test", indicators };
  const result = await execute(signal, config, makePortfolio(), makeSnapshot("BTC/USDT", 41398), 0);
  assert.equal(result.side, "hold");
  assert.equal(result.quantity, 0);
});

test("execute 'buy' returns a buy result priced at the real snapshot price for the actual symbol", async () => {
  const signal: TradeSignal = { type: "buy", symbol: "SOL/USDT", confidence: 0.8, reason: "test", indicators };
  const result = await execute(signal, config, makePortfolio(), makeSnapshot("SOL/USDT", 150), 300);
  assert.equal(result.side, "buy");
  assert.equal(result.price, 150);
  assert.equal(result.quantity, 300 / 150);
  assert(result.fee > 0);
});

test("execute 'buy' clamps quantity to available cash when the sized position is unaffordable", async () => {
  const signal: TradeSignal = { type: "buy", symbol: "SOL/USDT", confidence: 0.8, reason: "test", indicators };
  const portfolio = makePortfolio({ cashUsd: 50 });
  const result = await execute(signal, config, portfolio, makeSnapshot("SOL/USDT", 150), 300);
  assert.equal(result.side, "buy");
  const cost = result.quantity * result.price + result.fee;
  assert(cost <= 50);
});

test("execute 'sell' uses the actual held quantity, never a hardcoded guess", async () => {
  const signal: TradeSignal = { type: "sell", symbol: "SOL/USDT", confidence: 0.9, reason: "test", indicators };
  const portfolio = makePortfolio({ positions: [{ symbol: "SOL/USDT", quantity: 2.5, entryPrice: 140, currentPrice: 150 }] });
  const result = await execute(signal, config, portfolio, makeSnapshot("SOL/USDT", 150), 0);
  assert.equal(result.side, "sell");
  assert.equal(result.quantity, 2.5);
  assert.equal(result.price, 150);
});

test("execute 'sell' with no held position returns hold instead of fabricating a quantity", async () => {
  const signal: TradeSignal = { type: "sell", symbol: "SOL/USDT", confidence: 0.9, reason: "test", indicators };
  const result = await execute(signal, config, makePortfolio(), makeSnapshot("SOL/USDT", 150), 0);
  assert.equal(result.side, "hold");
  assert.equal(result.quantity, 0);
});
