import { test } from "node:test";
import assert from "node:assert/strict";
import { empty, update } from "../src/portfolio.ts";
import type { TradeResult } from "../src/executor.ts";

test("empty creates an empty portfolio with default cash", () => {
  const p = empty();
  assert.equal(p.positions.length, 0);
  assert.equal(p.cashUsd, 1000);
  assert.equal(p.dailyTradeCount, 0);
  assert.equal(p.maxCapitalUsd, 1000);
});

test("update with 'buy' adds a position and deducts cash", () => {
  const p = empty();
  const trade: TradeResult = {
    symbol: "BTC/USDT", side: "buy", quantity: 0.01, price: 40000, fee: 0.4, timestamp: 1,
  };
  const updated = update(p, trade);
  assert.equal(updated.positions.length, 1);
  assert.equal(updated.positions[0]!.symbol, "BTC/USDT");
  assert(updated.cashUsd < 1000);
  assert.equal(updated.dailyTradeCount, 1);
  assert.equal(updated.maxCapitalUsd, 1000);
});

test("update with 'sell' removes position and adds proceeds", () => {
  const p = {
    positions: [{ symbol: "BTC/USDT", quantity: 0.01, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 10400,
    cashUsd: 10000,
    dailyTradeCount: 0,
    maxCapitalUsd: 10000,
  };
  const trade: TradeResult = {
    symbol: "BTC/USDT", side: "sell", quantity: 0.01, price: 42000, fee: 0.42, timestamp: 2,
  };
  const updated = update(p, trade);
  assert.equal(updated.positions.length, 0);
  assert(updated.cashUsd > 10000); // profit
  assert.equal(updated.dailyTradeCount, 1);
  assert.equal(updated.maxCapitalUsd, 10000);
});

test("update with 'hold' does not change positions or trade count", () => {
  const p = empty();
  const trade: TradeResult = {
    symbol: "BTC/USDT", side: "hold", quantity: 0, price: 0, fee: 0, timestamp: 3,
  };
  const updated = update(p, trade);
  assert.equal(updated.positions.length, 0);
  assert.equal(updated.dailyTradeCount, 0);
});