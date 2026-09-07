import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEntry, recordExit, getHistory, getClosedTrades, clearJournal } from "../src/learning/journal.ts";
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

test("recordEntry adds a new trade to the journal", () => {
  clearJournal();
  const record = recordEntry(makeSignal(), makeResult(), "paper");
  assert.equal(record.symbol, "BTC/USDT");
  assert.equal(record.side, "buy");
  assert.equal(record.status, "open");
  assert.equal(getHistory().length, 1);
});

test("recordExit closes an open trade", () => {
  clearJournal();
  recordEntry(makeSignal(), makeResult({ side: "buy", price: 40000 }), "paper");
  const closed = recordExit("BTC/USDT", 42000, Date.now(), 0.42);
  assert(closed !== null);
  assert.equal(closed.status, "closed");
  assert(closed.pnl !== undefined);
  assert(closed.pnl! > 0); // profit
});

test("recordExit returns null if no open trade", () => {
  clearJournal();
  const result = recordExit("BTC/USDT", 42000, Date.now(), 0);
  assert.equal(result, null);
});

test("getClosedTrades returns only closed trades", () => {
  clearJournal();
  recordEntry(makeSignal(), makeResult({ side: "buy" }), "paper");
  assert.equal(getClosedTrades().length, 0);
  recordExit("BTC/USDT", 42000, Date.now(), 0);
  assert.equal(getClosedTrades().length, 1);
});

test("clearJournal resets state", () => {
  clearJournal();
  recordEntry(makeSignal(), makeResult(), "paper");
  clearJournal();
  assert.equal(getHistory().length, 0);
});