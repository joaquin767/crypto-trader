// Circuit breaker (journal-driven) tests — specs/daily-catalyst-manual-trading.md §5.8a,
// AC-63/63a/63c/63d.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBreaker } from "../src/journal/breaker.ts";
import type { BreakerConfig } from "../src/journal/breaker.ts";
import type { ManualTrade } from "../src/journal/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const BASE_CFG: BreakerConfig = {
  maxDailyLossPercent: 10, maxDrawdownHaltPercent: 20, maxConsecutiveLosses: 5,
  maxSlippagePercent: 2, breakerResetAt: null,
};

let nextId = 0;

/** A minimal closed bybit-live trade whose net PnL is exactly `netPnl` (one entry fill worth
 *  $0 fee at price 100 qty 1, one exit fill priced so gross - fees = netPnl, fees kept at 0 for
 *  arithmetic simplicity — computeBreaker only cares about the resulting netPnlUsd). */
function closedTrade(netPnl: number, exitTime: number): ManualTrade {
  const id = `t${nextId++}`;
  return {
    id, venue: "bybit-live", symbol: "BTC/USDT", side: "long",
    planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [{ execId: `${id}-e`, time: exitTime - 1000, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [{ execId: `${id}-x`, time: exitTime, price: 100 + netPnl, qty: 1, feeUsd: 0, side: "sell" }],
    actualLeverage: 1, exchangeLiqPrice: null, fundingUsd: 0,
    status: "closed", exitKind: "discretionary", notes: "", createdAt: exitTime - 1000, updatedAt: exitTime,
  };
}

const DAY1 = Date.UTC(2026, 8, 1, 12, 0, 0);
const DAY2 = Date.UTC(2026, 8, 2, 12, 0, 0);
const DAY3 = Date.UTC(2026, 8, 3, 12, 0, 0);

test("AC-63: three -4 net trades same UTC day trips dailyLoss at 12% loss", () => {
  const trades = [closedTrade(-4, DAY1), closedTrade(-4, DAY1 + 1000), closedTrade(-4, DAY1 + 2000)];
  const result = computeBreaker(trades, BASE_CFG, 100, DAY1 + 3000);
  assert.equal(result.tripped, true);
  assert.equal(result.trigger, "dailyLoss");
});

test("AC-63: the same trades on a previous day, nothing today, is not tripped by dailyLoss", () => {
  const trades = [closedTrade(-4, DAY1), closedTrade(-4, DAY1 + 1000), closedTrade(-4, DAY1 + 2000)];
  const result = computeBreaker(trades, BASE_CFG, 100, DAY2 + 3000);
  assert.equal(result.tripped, false);
});

test("AC-63a: -6, -6, +10 trips dailyLoss from the second trade even though final equity is 98", () => {
  const trades = [closedTrade(-6, DAY1), closedTrade(-6, DAY1 + 1000), closedTrade(10, DAY1 + 2000)];
  const result = computeBreaker(trades, BASE_CFG, 100, DAY1 + 3000);
  assert.equal(result.tripped, true);
  assert.equal(result.trigger, "dailyLoss");
});

test("AC-63a: the next UTC day with no new trades is not tripped by dailyLoss", () => {
  const trades = [closedTrade(-6, DAY1), closedTrade(-6, DAY1 + 1000), closedTrade(10, DAY1 + 2000)];
  const result = computeBreaker(trades, BASE_CFG, 100, DAY2 + 3000);
  assert.equal(result.tripped, false);
});

test("AC-63c: 5 consecutive -1 losses then a +3 winner two days later stays tripped (consecutiveLosses)", () => {
  const trades = [
    closedTrade(-1, DAY1), closedTrade(-1, DAY1 + 1000), closedTrade(-1, DAY1 + 2000),
    closedTrade(-1, DAY1 + 3000), closedTrade(-1, DAY1 + 4000),
    closedTrade(3, DAY3),
  ];
  const result = computeBreaker(trades, BASE_CFG, 100, DAY3 + 1000);
  assert.equal(result.tripped, true);
  assert.equal(result.trigger, "consecutiveLosses");
});

test("AC-63c: a breakerResetAt between the 5th loss and the winner clears the latch", () => {
  const trades = [
    closedTrade(-1, DAY1), closedTrade(-1, DAY1 + 1000), closedTrade(-1, DAY1 + 2000),
    closedTrade(-1, DAY1 + 3000), closedTrade(-1, DAY1 + 4000),
    closedTrade(3, DAY3),
  ];
  const cfg: BreakerConfig = { ...BASE_CFG, breakerResetAt: DAY1 + 5000 };
  const result = computeBreaker(trades, cfg, 100, DAY3 + 1000);
  assert.equal(result.tripped, false);
});

test("AC-63c: a drawdown trip followed by recovery above the threshold, without a reset, stays tripped", () => {
  // Losses spread across 3 separate UTC days (8% each, under the 10% dailyLoss threshold) so
  // only the cumulative 24% drawdown from peak trips — isolating "drawdown" from "dailyLoss".
  const DAY4 = Date.UTC(2026, 8, 4, 12, 0, 0);
  const trades = [
    closedTrade(-8, DAY1), // 100 -> 92
    closedTrade(-8, DAY2), // 92 -> 84
    closedTrade(-8, DAY3), // 84 -> 76 (24% drawdown from peak 100) -> trips drawdown
    closedTrade(30, DAY4), // 76 -> 106, recovers well above the 20% drawdown threshold
  ];
  const result = computeBreaker(trades, BASE_CFG, 100, DAY4 + 1000);
  assert.equal(result.tripped, true);
  assert.equal(result.trigger, "drawdown");
});

test("AC-63d: a -6 trade at 23:30 UTC day1 and a -6 trade at 00:30 UTC day2 never trips dailyLoss", () => {
  const day1_2330 = Date.UTC(2026, 8, 1, 23, 30, 0);
  const day2_0030 = day1_2330 + HOUR_MS;
  const trades = [closedTrade(-6, day1_2330), closedTrade(-6, day2_0030)];
  const result = computeBreaker(trades, BASE_CFG, 100, day2_0030 + 1000);
  assert.equal(result.tripped, false);
});

test("AC-63d: two -6 trades at 00:30 and 01:30 UTC day2 (after a flat day1) trips dailyLoss at 12%", () => {
  const day2_0030 = Date.UTC(2026, 8, 2, 0, 30, 0);
  const day2_0130 = day2_0030 + HOUR_MS;
  const trades = [closedTrade(-6, day2_0030), closedTrade(-6, day2_0130)];
  const result = computeBreaker(trades, BASE_CFG, 100, day2_0130 + 1000);
  assert.equal(result.tripped, true);
  assert.equal(result.trigger, "dailyLoss");
});

test("computeBreaker: paper trades never count toward the breaker", () => {
  const paperTrade: ManualTrade = { ...closedTrade(-50, DAY1), venue: "paper" };
  const result = computeBreaker([paperTrade], BASE_CFG, 100, DAY1 + 1000);
  assert.equal(result.tripped, false);
});

test("computeBreaker: no trades at all is never tripped", () => {
  const result = computeBreaker([], BASE_CFG, 100, DAY1);
  assert.equal(result.tripped, false);
  assert.equal(result.trigger, null);
});
