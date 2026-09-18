// stats.ts tests — specs/daily-catalyst-manual-trading.md §5.10a "Statistics",
// AC-76, AC-85, AC-87, AC-91.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootstrapCi90, mulberry32, percentile, permutationPValue, topSymbolShare } from "../src/backtest-daily/stats.ts";
import type { SimTrade } from "../src/backtest-daily/simulate.ts";

function trade(overrides: Partial<SimTrade> = {}): SimTrade {
  return {
    planId: "p", ruleId: "r", symbol: "BTC/USDT", decisionDay: "2026-01-01",
    entryTime: 0, exitTime: 0, entryPrice: 100, exitPrice: 100, exitKind: "time",
    netPnlUsd: 0, riskUsd: 1, rMultiple: 0, fundingUsd: 0, feesUsd: 0,
    ...overrides,
  };
}

// ── AC-76 ────────────────────────────────────────────────────────────────────────────────────

test("AC-76: mulberry32(1) produces a fixed first-three-value sequence", () => {
  const rng = mulberry32(1);
  const values = [rng(), rng(), rng()];
  assert.deepEqual(values, [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
});

test("AC-76: two mulberry32 generators with the same seed produce identical 1000-value sequences", () => {
  const a = mulberry32(20260917);
  const b = mulberry32(20260917);
  const seqA = Array.from({ length: 1000 }, () => a());
  const seqB = Array.from({ length: 1000 }, () => b());
  assert.deepEqual(seqA, seqB);
});

// ── AC-85 ────────────────────────────────────────────────────────────────────────────────────

test("AC-85: bootstrap on R=[1,1,1,1] (4 distinct days) gives CI90 [1,1]", () => {
  const trades = [1, 1, 1, 1].map((r, i) => trade({ decisionDay: `2026-01-0${i + 1}`, rMultiple: r }));
  const [lo, hi] = bootstrapCi90(trades, 10_000, 20260917);
  assert.equal(lo, 1);
  assert.equal(hi, 1);
});

test("AC-85: permutationPValue uses (1+k)/(1+runs): 0 of 999 exceeding observed -> p = 0.001", () => {
  const runMeanRs = Array.from({ length: 999 }, () => 0); // all strictly below the observed mean
  const p = permutationPValue(1, runMeanRs);
  assert.equal(p, 0.001);
});

// ── AC-87 ────────────────────────────────────────────────────────────────────────────────────

test("AC-87: topSymbolShare for per-symbol P&L {A:+8, B:+2, C:-20} is 0.8", () => {
  const trades = [
    trade({ symbol: "A", netPnlUsd: 8 }),
    trade({ symbol: "B", netPnlUsd: 2 }),
    trade({ symbol: "C", netPnlUsd: -20 }),
  ];
  assert.equal(topSymbolShare(trades), 0.8);
});

// ── AC-91 ────────────────────────────────────────────────────────────────────────────────────

/** Per-trade i.i.d. bootstrap (deliberately NOT how stats.ts does it) — used only as the
 *  comparison baseline this AC requires the test to compute itself. */
function perTradeBootstrapCi90(rValues: readonly number[], resamples: number, seed: number): [number, number] {
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < rValues.length; j++) {
      sum += rValues[Math.floor(rng() * rValues.length)]!;
    }
    means.push(sum / rValues.length);
  }
  return [percentile(means, 0.05), percentile(means, 0.95)];
}

test("AC-91: day-clustered bootstrap CI90 is strictly wider than a per-trade i.i.d. bootstrap of the same values", () => {
  const dayRs = [-1, 2, -1, 2, -1, 2, -1, 2, -1, 2]; // one R per day, that day's 4 trades all share it
  const trades: SimTrade[] = [];
  const flat: number[] = [];
  for (let day = 0; day < 10; day++) {
    const r = dayRs[day]!;
    for (let k = 0; k < 4; k++) {
      trades.push(trade({ decisionDay: `2026-02-${String(day + 1).padStart(2, "0")}`, rMultiple: r }));
      flat.push(r);
    }
  }
  const seed = 20260917;
  const [dayLo, dayHi] = bootstrapCi90(trades, 10_000, seed);
  const [tradeLo, tradeHi] = perTradeBootstrapCi90(flat, 10_000, seed);

  const dayWidth = dayHi - dayLo;
  const tradeWidth = tradeHi - tradeLo;
  assert.ok(dayWidth > tradeWidth, `expected day-clustered width ${dayWidth} > per-trade width ${tradeWidth}`);
});
