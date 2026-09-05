import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.ts";
import type { TradeSignal } from "../src/strategy/signals.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
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

test("execute 'hold' returns a hold result", async () => {
  const signal: TradeSignal = { type: "hold", symbol: "BTC/USDT", confidence: 1, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
  const result = await execute(signal, config);
  assert.equal(result.side, "hold");
  assert.equal(result.quantity, 0);
});

test("execute 'buy' returns a buy result with quantity and fee", async () => {
  const signal: TradeSignal = { type: "buy", symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
  const result = await execute(signal, config);
  assert.equal(result.side, "buy");
  assert(result.quantity > 0);
  assert(result.fee > 0);
  assert(result.price > 0);
});

test("execute 'sell' returns a sell result", async () => {
  const signal: TradeSignal = { type: "sell", symbol: "BTC/USDT", confidence: 0.9, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
  const result = await execute(signal, config);
  assert.equal(result.side, "sell");
  assert(result.quantity > 0);
});