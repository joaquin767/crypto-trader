import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { analyze, clearHistory } from "../src/strategy/signals.ts";
import { empty } from "../src/portfolio.ts";
import { calcRSI, calcSMA, calcBollinger } from "../src/strategy/indicators.ts";
import { calcPositionSize } from "../src/strategy/risk.ts";
import { recordEntry, recordExit, clearJournal, getHistory } from "../src/learning/journal.ts";
import { analyze as analyzePerf } from "../src/learning/analyzer.ts";
import { execute } from "../src/executor.ts";
import type { Config } from "../src/config.ts";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configPath = join(tmpdir(), `crypto-trader-v2-int-test-${Date.now()}.json`);

test("loadConfig loads and validates a config", () => {
  const config: Config = {
    exchange: "binance", apiKey: "test", apiSecret: "test",
    symbols: ["BTC/USDT"], maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  };
  writeFileSync(configPath, JSON.stringify(config));
  try {
    const loaded = loadConfig(configPath);
    assert.equal(loaded.exchange, "binance");
    assert.deepEqual(loaded.symbols, ["BTC/USDT"]);
    assert.equal(loaded.refreshIntervalMs, 3000);
  } finally {
    if (existsSync(configPath)) unlinkSync(configPath);
  }
});

test("technical indicators produce reasonable values", () => {
  const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
  const rsi = calcRSI(prices, 14);
  assert(rsi >= 0 && rsi <= 100, `RSI ${rsi} out of range`);

  const sma = calcSMA(prices, 10);
  assert(sma > 0);

  const bb = calcBollinger(prices, 20, 2);
  assert(bb.upper > bb.middle);
  assert(bb.lower < bb.middle);
});

test("risk management respects position size limits", () => {
  const config: Config = {
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 500,
  maxPositionSizeUsd: 500,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  };
  const size = calcPositionSize(empty(), config, 0, 40000);
  assert(size <= 500);
});

test("expert signal generation with indicators", () => {
  clearHistory();
  const config: Config = {
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  };
  const signal = analyze(
    { symbol: "BTC/USDT", price: 40000, change24h: 3, volume24h: 600, timestamp: Date.now() },
    empty(),
    config,
  );
  assert(signal.indicators);
  assert(typeof signal.indicators.rsi === "number");
  assert(typeof signal.indicators.macd.bullish === "boolean");
});

test("journal records and closes trades end-to-end", () => {
  clearJournal();
  const signal = {
    type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test",
    indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false },
      bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 },
      momentum: 2, atr: 100 },
  };
  const entry = recordEntry(signal, {
    symbol: "BTC/USDT", side: "buy", quantity: 0.01, price: 40000, fee: 0.4, timestamp: 1,
  }, "paper");
  assert.equal(entry.status, "open");

  const exit = recordExit("BTC/USDT", 42000, 2, 0.42);
  assert(exit !== null);
  assert.equal(exit.status, "closed");
  assert(exit.pnl! > 0);
});

test("performance analyzer works with trade journal", () => {
  clearJournal();

  // Winning trade
  recordEntry(
    { type: "buy", symbol: "BTC/USDT", confidence: 0.8, reason: "test",
      indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false },
        bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 },
        momentum: 2, atr: 100 } },
    { symbol: "BTC/USDT", side: "buy", quantity: 0.01, price: 40000, fee: 0.4, timestamp: 1 },
    "paper",
  );
  recordExit("BTC/USDT", 42000, 2, 0.42);

  const report = analyzePerf(10000);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.winRate, 1);
  assert(report.totalPnl > 0);
});

test("executor handles hold signals", async () => {
  const config: Config = {
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  };
  const result = await execute(
    { type: "hold", symbol: "BTC/USDT", confidence: 1, reason: "test",
      indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false },
        bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 },
        momentum: 0, atr: 100 } },
    config,
    empty(),
    { symbol: "BTC/USDT", price: 40000, change24h: 0, volume24h: 0, timestamp: Date.now() },
    0,
  );
  assert.equal(result.side, "hold");
  assert.equal(result.quantity, 0);
});

test("end-to-end: config -> indicators -> signal -> journal", () => {
  clearHistory();
  clearJournal();

  const config: Config = {
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  };

  // This simulates one cycle of the trading loop
  const snapshot = { symbol: "BTC/USDT", price: 41000, change24h: 4, volume24h: 700, timestamp: Date.now() };
  const signal = analyze(snapshot, empty(), config);

  // The signal should be a valid TradeSignal
  assert(["buy", "sell", "hold"].includes(signal.type));
  assert(signal.confidence >= 0 && signal.confidence <= 1);

  // Indicators should be populated
  assert(signal.indicators.rsi >= 0 && signal.indicators.rsi <= 100);

  console.log(`[integration] Signal: ${signal.type} @ ${signal.confidence} — ${signal.reason}`);
});