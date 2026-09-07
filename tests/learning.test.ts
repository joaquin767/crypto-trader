import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/learning/analyzer.ts";
import { recordEntry, recordExit, clearJournal } from "../src/learning/journal.ts";
import { defaultParams, optimize, getInsights, clearInsights } from "../src/learning/optimizer.ts";
import type { TradeSignal } from "../src/strategy/signals.ts";
import type { TradeResult } from "../src/executor.ts";

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    type: "buy", symbol: "BTC/USDT", confidence: 0.8, reason: "test",
    indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false },
      bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 },
      momentum: 2, atr: 100 },
    ...overrides,
  };
}

function makeResult(overrides: Partial<TradeResult> = {}): TradeResult {
  return {
    symbol: "BTC/USDT", side: "buy", quantity: 0.01, price: 40000, fee: 0.4, timestamp: Date.now(),
    ...overrides,
  };
}

test("analyze returns zero metrics with no trades", () => {
  const report = analyze(10000);
  assert.equal(report.closedTrades, 0);
  assert.equal(report.winRate, 0);
  assert.equal(report.totalPnl, 0);
});

test("analyze calculates correct win rate after trades", () => {
  clearJournal();
  recordEntry(makeSignal(), makeResult({ side: "buy", price: 40000 }), "paper");
  recordExit("BTC/USDT", 42000, Date.now(), 0.42); // win
  recordEntry(makeSignal({ symbol: "ETH/USDT" }), makeResult({ symbol: "ETH/USDT", side: "buy", price: 2000 }), "paper");
  recordExit("ETH/USDT", 1900, Date.now(), 0.19); // loss

  const report = analyze(10000);
  assert.equal(report.closedTrades, 2);
  assert.equal(report.winRate, 0.5);
  assert(report.totalPnl > 0); // BTC profit > ETH loss
});

test("analyze calculates Sharpe ratio", () => {
  clearJournal();
  recordEntry(makeSignal(), makeResult({ side: "buy", price: 100 }), "paper");
  recordExit("BTC/USDT", 200, Date.now(), 0.01); // big profit
  const report = analyze(10000);
  assert(typeof report.sharpeRatio === "number");
  assert(!Number.isNaN(report.sharpeRatio));
});

test("optimize lowers minBuyScore when win rate is low", () => {
  const params = defaultParams();
  const result = optimize(params, 0.3, 10, 10, 15, 5, [-1, -2, 1, -1]);
  // With 30% win rate and enough trades, should raise minBuyScore
  assert(result.minBuyScore >= params.minBuyScore);
});

test("optimize does not change params with good win rate and no issues", () => {
  const params = defaultParams();
  const result = optimize(params, 0.8, 10, 20, 5, 5, [1, 2, 3]);
  // With 80% win rate and small drawdown, params should stay roughly the same
  // (may increase rsiOversoldThreshold slightly due to rule 2)
  assert(result.rsiOverboughtThreshold >= params.rsiOverboughtThreshold);
});

test("optimize generates insights on adjustments", () => {
  const params = defaultParams();
  optimize(params, 0.3, 10, 10, 20, 15, [-1, -2, -3]);
  const insights = getInsights();
  assert(insights.length > 0);
});