// simulatePlan tests — specs/daily-catalyst-manual-trading.md §5.10a "Simulation",
// AC-20, AC-21, AC-79, AC-80, AC-81, AC-82.

import { test } from "node:test";
import assert from "node:assert/strict";

import { simulatePlan } from "../src/backtest-daily/simulate.ts";
import type { SimTrade } from "../src/backtest-daily/simulate.ts";
import type { TradePlan } from "../src/research/planner.ts";
import type { Kline, SourceRow } from "../src/research/types.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DECISION_TIME = Date.UTC(2026, 8, 16, 0, 15, 0); // 2026-09-16T00:15:00Z
const FAR_FUTURE_CUTOFF = DECISION_TIME + 365 * DAY;

function plan(overrides: Partial<Extract<TradePlan, { kind: "plan" }>> = {}): Extract<TradePlan, { kind: "plan" }> {
  return {
    kind: "plan", planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "hash",
    origin: "rules-file", symbol: "BTC/USDT", side: "long",
    referencePrice: 100, stopPrice: 95, targetPrice: 110, expiresAt: DECISION_TIME + 12 * HOUR,
    quantity: 1, notionalUsd: 100, riskUsd: 10, leverage: 1, marginUsd: 100,
    estLiquidationPrice: 50, liqToStopRatio: 2, estRoundTripFeeUsd: 0.11,
    venueIntent: "paper", maxHoldDays: 5,
    ...overrides,
  };
}

function bar(t: number, o: number, h: number, l: number, c: number): Kline {
  return { t, o, h, l, c, v: 1000 };
}

// Zero-rate settlements every 8 h covering the bars, so the funding-coverage check passes without changing
// any test's expected funding.
function zeroFunding(bars: readonly Kline[], symbol = "BTC/USDT"): SourceRow[] {
  const rows: SourceRow[] = [];
  if (bars.length === 0) return rows;
  const from = Math.min(...bars.map((b) => b.t)) - 8 * HOUR;
  const to = Math.max(...bars.map((b) => b.t)) + 16 * HOUR;
  for (let t = from; t <= to; t += 8 * HOUR) rows.push({ key: symbol, observedFor: t, availableAt: t, field: "fundingRate", value: 0 });
  return rows;
}

function isSimTrade(r: SimTrade | { kind: "unfilled"; reason: string }): r is SimTrade {
  return !("kind" in r);
}

// ── AC-20 ────────────────────────────────────────────────────────────────────────────────────

test("AC-20: a bar whose low <= stop and high >= target resolves to exitKind stop", () => {
  const p = plan();
  const bars = [
    bar(DECISION_TIME, 100, 101, 99, 100), // entry bar, no touch
    bar(DECISION_TIME + HOUR, 100, 111, 94, 100), // both stop (95) and target (110) touched intrabar
  ];
  const result = simulatePlan(p, bars, zeroFunding(bars), p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result));
  if (isSimTrade(result)) assert.equal(result.exitKind, "stop");
});

// ── AC-21 ────────────────────────────────────────────────────────────────────────────────────

test("AC-21: a long held across 2 funding settlements at +0.01% on $30 notional gives fundingUsd -0.006", () => {
  const p = plan({ quantity: 1, referencePrice: 30, stopPrice: 20, targetPrice: 200, riskUsd: 10, maxHoldDays: 1 });
  // Flat at 30 throughout (well inside [20, 200]) for the full 1-day hold -> time exit.
  const bars: Kline[] = [];
  for (let h = 0; h <= 23; h++) bars.push(bar(DECISION_TIME + h * HOUR, 30, 30, 30, 30));
  const funding: SourceRow[] = [
    ...zeroFunding(bars),
    { key: "BTC/USDT", observedFor: DECISION_TIME + HOUR, availableAt: DECISION_TIME + HOUR, field: "fundingRate", value: 0.0001 },
    { key: "BTC/USDT", observedFor: DECISION_TIME + 2 * HOUR, availableAt: DECISION_TIME + 2 * HOUR, field: "fundingRate", value: 0.0001 },
  ];
  const result = simulatePlan(p, bars, funding, p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result));
  if (isSimTrade(result)) assert.ok(Math.abs(result.fundingUsd - -0.006) < 1e-9);
});

test("AC-82: a funding row exactly at entryTime is not applied; one exactly at exitTime is", () => {
  const p = plan({ quantity: 1, referencePrice: 30, stopPrice: 20, targetPrice: 200, riskUsd: 10, maxHoldDays: 1 });
  // entryBar at DECISION_TIME; boundary = entry + 1 day. Last in-window bar closes exactly at
  // the boundary, so the time exit fires with exitTime = lastBar.t + 1h.
  const lastBarT = DECISION_TIME + 23 * HOUR;
  const bars: Kline[] = [];
  // One extra bar (h=24) past the hold boundary so markAt can price the funding row that lands
  // exactly on exitTime — it's never used for the stop/target/time-exit decision itself (the
  // loop stops as soon as it sees a bar beyond the boundary), only for the funding lookup.
  for (let h = 0; h <= 24; h++) bars.push(bar(DECISION_TIME + h * HOUR, 30, 30, 30, 30));
  const exitTime = lastBarT + HOUR; // == entryBar.t + 24h == boundary
  const funding: SourceRow[] = [
    ...zeroFunding(bars),
    { key: "BTC/USDT", observedFor: DECISION_TIME, availableAt: DECISION_TIME, field: "fundingRate", value: 0.0001 }, // == entryTime, excluded
    { key: "BTC/USDT", observedFor: DECISION_TIME + 4 * HOUR, availableAt: DECISION_TIME + 4 * HOUR, field: "fundingRate", value: 0.0002 }, // not on 00/08/16 UTC
    { key: "BTC/USDT", observedFor: exitTime, availableAt: exitTime, field: "fundingRate", value: 0.0003 }, // == exitTime, included
  ];
  const result = simulatePlan(p, bars, funding, p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result));
  if (isSimTrade(result)) {
    assert.equal(result.exitKind, "time");
    assert.equal(result.exitTime, exitTime);
    // Only the 0.0002 (t+4h) and 0.0003 (exitTime) rows apply; mark = 30 throughout, qty = 1.
    assert.ok(Math.abs(result.fundingUsd - -(0.0002 + 0.0003) * 30) < 1e-9);
  }
});

// ── AC-79 ────────────────────────────────────────────────────────────────────────────────────

test("AC-79: gap-through stop, no-gap-bonus target, and target never overshoots to a later gap", () => {
  const p = plan({ stopPrice: 95, targetPrice: 110, quantity: 1 });
  // bar1 opens 94 -> immediate gap-through stop at 94 (worse than the stop, no separate later exit).
  const bars = [bar(DECISION_TIME, 94, 96, 93, 95)];
  const result1 = simulatePlan(p, bars, zeroFunding(bars), p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result1));
  if (isSimTrade(result1)) { assert.equal(result1.exitKind, "stop"); assert.equal(result1.exitPrice, 94); }

  // bar with o 100 h 111 l 99 -> target hit intrabar at 110 (not the high of 111).
  const bars2 = [
    bar(DECISION_TIME, 100, 101, 99, 100),
    bar(DECISION_TIME + HOUR, 100, 111, 99, 105),
  ];
  const result2 = simulatePlan(p, bars2, zeroFunding(bars2), p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result2));
  if (isSimTrade(result2)) { assert.equal(result2.exitKind, "target"); assert.equal(result2.exitPrice, 110); }

  // o 112 on a later bar (gap through target) -> exits at 110, never 112.
  const bars3 = [
    bar(DECISION_TIME, 100, 101, 99, 100),
    bar(DECISION_TIME + HOUR, 112, 115, 111, 113),
  ];
  const result3 = simulatePlan(p, bars3, zeroFunding(bars3), p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result3));
  if (isSimTrade(result3)) { assert.equal(result3.exitKind, "target"); assert.equal(result3.exitPrice, 110); }
});

// ── AC-80 ────────────────────────────────────────────────────────────────────────────────────

test("AC-80: slippageBps 5 fills a long entry at 100.05 and a stop exit at 95 fills at 94.9525", () => {
  const p = plan({ stopPrice: 95, targetPrice: 200 });
  const bars = [
    bar(DECISION_TIME, 100, 101, 99, 100),
    bar(DECISION_TIME + HOUR, 100, 100, 94, 95), // intrabar touch of stop only
  ];
  const result = simulatePlan(p, bars, zeroFunding(bars), p.maxHoldDays, 5, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result));
  if (isSimTrade(result)) {
    assert.ok(Math.abs(result.entryPrice - 100.05) < 1e-9);
    assert.ok(Math.abs(result.exitPrice - 94.9525) < 1e-9);
  }
});

// ── AC-81 ────────────────────────────────────────────────────────────────────────────────────

test("AC-81: a missing bar between entry and the exit bar is unfilled with reason containing 'gap'", () => {
  const p = plan({ stopPrice: 50, targetPrice: 200 }); // levels far away -> nothing hit before the gap
  const bars = [
    bar(DECISION_TIME, 100, 101, 99, 100),
    // Missing bar at DECISION_TIME + 1h.
    bar(DECISION_TIME + 2 * HOUR, 100, 101, 99, 100),
  ];
  const result = simulatePlan(p, bars, zeroFunding(bars), p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(!isSimTrade(result));
  if (!isSimTrade(result)) assert.match(result.reason, /gap/);
});

test("AC-81: a needed bar beyond cutoffMs is unfilled with reason containing 'cutoff'", () => {
  const p = plan({ stopPrice: 50, targetPrice: 200, maxHoldDays: 5 });
  const bars = [
    bar(DECISION_TIME, 100, 101, 99, 100),
    bar(DECISION_TIME + HOUR, 100, 101, 99, 100),
  ];
  const cutoff = DECISION_TIME + HOUR + 30 * 60 * 1000; // cuts off before the second bar closes
  const result = simulatePlan(p, bars, zeroFunding(bars), p.maxHoldDays, 0, cutoff);
  assert.ok(!isSimTrade(result));
  if (!isSimTrade(result)) assert.match(result.reason, /cutoff/);
});

test("no bar at or after decision time is unfilled", () => {
  const p = plan();
  const bars = [bar(DECISION_TIME - 2 * HOUR, 100, 101, 99, 100)];
  const result = simulatePlan(p, bars, zeroFunding(bars), p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(!isSimTrade(result));
});

// ── Funding completeness (conservative cost, §5.10a) ─────────────────────────────────────────────

test("a gap in funding history during the hold makes the plan unfilled instead of undercounting funding", () => {
  const p = plan({ quantity: 1, referencePrice: 30, stopPrice: 20, targetPrice: 200, riskUsd: 10, maxHoldDays: 1 });
  const bars: Kline[] = [];
  for (let h = 0; h <= 23; h++) bars.push(bar(DECISION_TIME + h * HOUR, 30, 30, 30, 30));
  // Settlements every 8 h except the one at +8 h is missing (16 h spacing).
  const funding = zeroFunding(bars).filter((r) => r.observedFor !== DECISION_TIME - 8 * HOUR + 16 * HOUR);
  const result = simulatePlan(p, bars, funding, p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(!isSimTrade(result));
  if (!isSimTrade(result)) assert.match(result.reason, /gap in funding history/);
});

test("an intrabar stop is timed at the bar close, so a settlement inside that hour is charged", () => {
  const p = plan({ quantity: 1, referencePrice: 100, stopPrice: 95, targetPrice: 200, riskUsd: 5 });
  const bars = [
    bar(DECISION_TIME, 100, 101, 99, 100),
    bar(DECISION_TIME + HOUR, 100, 100, 94, 95), // stop touched intrabar
  ];
  const settlement = DECISION_TIME + HOUR + 30 * 60_000; // inside the exit bar
  const funding: SourceRow[] = [
    ...zeroFunding(bars),
    { key: "BTC/USDT", observedFor: settlement, availableAt: settlement, field: "fundingRate", value: 0.001 },
  ];
  const result = simulatePlan(p, bars, funding, p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result));
  if (isSimTrade(result)) {
    assert.equal(result.exitTime, DECISION_TIME + 2 * HOUR);
    assert.ok(Math.abs(result.fundingUsd - -0.001 * 1 * 95) < 1e-9, `fundingUsd ${result.fundingUsd}`);
  }
});

test("a gap-through stop at the open keeps the open as exit time", () => {
  const p = plan();
  const bars = [bar(DECISION_TIME, 100, 101, 99, 100), bar(DECISION_TIME + HOUR, 90, 91, 89, 90)];
  const result = simulatePlan(p, bars, zeroFunding(bars), p.maxHoldDays, 0, FAR_FUTURE_CUTOFF);
  assert.ok(isSimTrade(result));
  if (isSimTrade(result)) assert.equal(result.exitTime, DECISION_TIME + HOUR);
});
