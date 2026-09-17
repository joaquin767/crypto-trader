// Trade chart tests — specs/daily-catalyst-manual-trading.md §5.14,
// AC-69, AC-70, AC-72, AC-73 (buildTradeChartData), AC-74.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildTradeChartData, chooseInterval, dailySigmaBeforeEntry, revealCandles, volatilityBand,
} from "../src/journal/chart.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import type { TradePlan } from "../src/research/planner.ts";
import type { Kline } from "../src/research/types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function bar(t: number, c: number): Kline {
  return { t, o: c, h: c, l: c, c, v: 1 };
}

function samplePlan(overrides: Partial<Extract<TradePlan, { kind: "plan" }>> = {}): Extract<TradePlan, { kind: "plan" }> {
  return {
    kind: "plan", planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "hash",
    origin: "rules-file", symbol: "BTC/USDT", side: "long",
    referencePrice: 100, stopPrice: 90, targetPrice: 130, expiresAt: 1_000_000_000,
    quantity: 1, notionalUsd: 100, riskUsd: 10, leverage: 2, marginUsd: 50,
    estLiquidationPrice: 50, liqToStopRatio: 2, estRoundTripFeeUsd: 0.11,
    venueIntent: "paper", maxHoldDays: 5,
    ...overrides,
  };
}

function trade(overrides: Partial<ManualTrade> = {}): ManualTrade {
  return {
    id: "t1", venue: "paper", symbol: "BTC/USDT", side: "long",
    planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "hash",
    plannedSnapshot: samplePlan(), aiStanceAtPlan: null,
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [], actualLeverage: null, exchangeLiqPrice: null,
    fundingUsd: 0, status: "open", exitKind: null, notes: "", createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

// ── AC-69: dailySigmaBeforeEntry ─────────────────────────────────────────────────────────────────
// Expected sigma independently computed (node -e) from the 7 log returns of
// [100,101,99,102,100,103,101,104]: 0.024757481633428422.

const AC69_SIGMA = 0.024757481633428422;

test("AC-69: sample stdev of the 7 log returns over 8 daily closes before entry", () => {
  const closes = [100, 101, 99, 102, 100, 103, 101, 104];
  const bars = closes.map((c, i) => bar(i * DAY_MS, c));
  const entryTime = 8 * DAY_MS; // exactly the 8th bar's close time (t + 24h) -> all 8 eligible
  const sigma = dailySigmaBeforeEntry(bars, entryTime);
  assert.ok(sigma !== null);
  assert.ok(Math.abs(sigma! - AC69_SIGMA) < 1e-9);
});

test("AC-69: a 9th bar whose close time is after entry does not change the result", () => {
  const closes = [100, 101, 99, 102, 100, 103, 101, 104];
  const bars = closes.map((c, i) => bar(i * DAY_MS, c));
  const entryTime = 8 * DAY_MS;
  const withExtra = [...bars, bar(8 * DAY_MS, 999)]; // close time 9*DAY_MS > entryTime
  const sigma = dailySigmaBeforeEntry(withExtra, entryTime);
  assert.ok(Math.abs(sigma! - AC69_SIGMA) < 1e-9);
});

test("AC-69: 7 eligible bars returns null (band omitted, never guessed)", () => {
  const closes = [100, 101, 99, 102, 100, 103, 101];
  const bars = closes.map((c, i) => bar(i * DAY_MS, c));
  const entryTime = 7 * DAY_MS;
  assert.equal(dailySigmaBeforeEntry(bars, entryTime), null);
});

// ── AC-70: volatilityBand ────────────────────────────────────────────────────────────────────────

test("AC-70: volatilityBand at entry is flat, at +4 days matches e^(k*sigma*sqrt(d))", () => {
  const T = 1_000_000;
  const points = volatilityBand(100, T, 0.02, [T, T + 4 * DAY_MS]);
  assert.equal(points.length, 2);
  const [atEntry, at4d] = points;
  for (const k of ["upper1", "lower1", "upper2", "lower2"] as const) {
    assert.ok(Math.abs(atEntry![k] - 100) < 1e-9, k);
  }
  assert.ok(Math.abs(at4d!.upper1 - 100 * Math.exp(0.04)) < 1e-9);
  assert.ok(Math.abs(at4d!.lower1 - 100 * Math.exp(-0.04)) < 1e-9);
  assert.ok(Math.abs(at4d!.upper2 - 100 * Math.exp(0.08)) < 1e-9);
  assert.ok(Math.abs(at4d!.lower2 - 100 * Math.exp(-0.08)) < 1e-9);
});

// ── AC-72: chooseInterval ────────────────────────────────────────────────────────────────────────

test("AC-72: chooseInterval picks 15m for a 48h span and 60m for 48h + 1ms", () => {
  const T = 1_000_000;
  assert.equal(chooseInterval(T, T + 48 * HOUR_MS), "15");
  assert.equal(chooseInterval(T, T + 48 * HOUR_MS + 1), "60");
});

// ── AC-74: revealCandles ─────────────────────────────────────────────────────────────────────────

test("AC-74: revealCandles reveals up to cursor, clamped to the array bounds", () => {
  const c = [0, 1, 2, 3, 4, 5];
  assert.deepEqual(revealCandles(c, 3), [0, 1, 2, 3]);
  assert.deepEqual(revealCandles(c, -5), [0]);
  assert.deepEqual(revealCandles(c, 999), c);
});

// ── buildTradeChartData: levels, window, P&L (AC-73) ───────────────────────────────────────────────

test("buildTradeChartData: levels come from plannedSnapshot; liquidation from the plan for a paper trade", () => {
  const t = trade();
  const data = buildTradeChartData(t, {
    candles: [], formingCandle: null, dailyBars: [], markPrice: null, markStale: false,
    now: 10 * HOUR_MS, interval: "60", dataStatus: "ok", dataDetail: "",
  });
  assert.equal(data.levels.entry, 100);
  assert.equal(data.levels.stop, 90);
  assert.equal(data.levels.target, 130);
  assert.equal(data.levels.liquidation, 50); // plannedSnapshot.estLiquidationPrice (paper)
  assert.equal(data.leverage, 2); // plannedSnapshot.leverage (paper)
});

test("buildTradeChartData: liquidation prefers exchangeLiqPrice, leverage prefers actualLeverage, for a live trade", () => {
  const t = trade({ venue: "bybit-live", exchangeLiqPrice: 42, actualLeverage: 3 });
  const data = buildTradeChartData(t, {
    candles: [], formingCandle: null, dailyBars: [], markPrice: null, markStale: false,
    now: 10 * HOUR_MS, interval: "60", dataStatus: "ok", dataDetail: "",
  });
  assert.equal(data.levels.liquidation, 42);
  assert.equal(data.leverage, 3);
});

test("buildTradeChartData: candle window is firstEntry - 6 bars .. lastExit + 6 bars for a closed trade", () => {
  const barMs = HOUR_MS;
  const entryTime = 100 * barMs;
  const exitTime = 105 * barMs;
  const t = trade({
    status: "closed", exitKind: "target",
    entryFills: [{ execId: "e1", time: entryTime, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [{ execId: "x1", time: exitTime, price: 110, qty: 1, feeUsd: 0, side: "sell" }],
  });
  // Deliberately over-fetch padding on both sides to verify the function trims to the window.
  const candles: Kline[] = [];
  for (let i = entryTime / barMs - 10; i <= exitTime / barMs + 10; i++) candles.push(bar(i * barMs, 100));
  const data = buildTradeChartData(t, {
    candles, formingCandle: null, dailyBars: [], markPrice: null, markStale: false,
    now: exitTime + 100 * barMs, interval: "60", dataStatus: "ok", dataDetail: "",
  });
  const expectedStart = entryTime - 6 * barMs;
  const expectedEnd = exitTime + 6 * barMs;
  assert.equal(data.candles[0]!.t, expectedStart);
  assert.equal(data.candles.at(-1)!.t, expectedEnd);
  assert.equal(data.candles.length, (expectedEnd - expectedStart) / barMs + 1);
  for (let i = 1; i < data.candles.length; i++) assert.ok(data.candles[i]!.t > data.candles[i - 1]!.t);
});

test("AC-73: an open paper long's unrealized P&L uses the last closed candle when there is no mark price", () => {
  const t = trade({
    venue: "paper", plannedSnapshot: null, ruleId: null, ruleHash: null,
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 2, feeUsd: 0.2, side: "buy" }],
  });
  const candles: Kline[] = [bar(0, 100), bar(15 * 60_000, 105)];
  const data = buildTradeChartData(t, {
    candles, formingCandle: null, dailyBars: [], markPrice: null, markStale: false,
    now: 30 * 60_000, interval: "15", dataStatus: "ok", dataDetail: "",
  });
  assert.deepEqual(data.pnl, { kind: "unrealized", usd: 9.8, basis: "last 15m close" });
});

test("buildTradeChartData: a bybit-live open trade's unrealized P&L uses the live mark price when fresh", () => {
  const t = trade({
    venue: "bybit-live", plannedSnapshot: null, ruleId: null, ruleHash: null,
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
  });
  const data = buildTradeChartData(t, {
    candles: [bar(0, 100)], formingCandle: null, dailyBars: [], markPrice: 108, markStale: false,
    now: 60_000, interval: "15", dataStatus: "ok", dataDetail: "",
  });
  assert.deepEqual(data.pnl, { kind: "unrealized", usd: 8, basis: "mark" });
});

test("buildTradeChartData: a closed trade's P&L is the journal's realized netPnlUsd", () => {
  const t = trade({
    status: "closed", exitKind: "target",
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1, feeUsd: 0.5, side: "buy" }],
    exitFills: [{ execId: "x1", time: HOUR_MS, price: 110, qty: 1, feeUsd: 0.5, side: "sell" }],
  });
  const data = buildTradeChartData(t, {
    candles: [], formingCandle: null, dailyBars: [], markPrice: null, markStale: false,
    now: 2 * HOUR_MS, interval: "60", dataStatus: "ok", dataDetail: "",
  });
  assert.equal(data.pnl?.kind, "realized");
  assert.ok(Math.abs(data.pnl!.usd - 9) < 1e-9); // (110-100)*1 - 1 fee + 0 funding
});

test("dataStatus unavailable yields no band, empty candles, and passes through the detail message", () => {
  const t = trade();
  const data = buildTradeChartData(t, {
    candles: [], formingCandle: null, dailyBars: [], markPrice: null, markStale: false,
    now: 10 * HOUR_MS, interval: "60", dataStatus: "unavailable", dataDetail: "kline data unavailable",
  });
  assert.equal(data.dataStatus, "unavailable");
  assert.equal(data.dataDetail, "kline data unavailable");
  assert.equal(data.band, null);
  assert.deepEqual(data.candles, []);
});
