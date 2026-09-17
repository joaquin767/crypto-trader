// Gate D0 tests — specs/daily-catalyst-manual-trading.md §5.10 / §5.10a,
// AC-23, AC-24, AC-25, AC-26, AC-92, AC-96, step 2b.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendLedger, globalEvaluationIndex, HOLDOUT_END_MS, HOLDOUT_START_MS, readLedger,
  ruleEvaluationIndex, runGateD0,
} from "../src/backtest-daily/gate-d0.ts";
import type { LedgerEntry, RunGateD0Options } from "../src/backtest-daily/gate-d0.ts";
import type { SimTrade } from "../src/backtest-daily/simulate.ts";

function trade(overrides: Partial<SimTrade> = {}): SimTrade {
  return {
    planId: "p", ruleId: "r", symbol: "BTC/USDT", decisionDay: "2026-01-01",
    entryTime: 0, exitTime: 0, entryPrice: 100, exitPrice: 100, exitKind: "time",
    netPnlUsd: 0, riskUsd: 1, rMultiple: 1, fundingUsd: 0, feesUsd: 0,
    ...overrides,
  };
}

function baseOpts(overrides: Partial<RunGateD0Options> = {}): RunGateD0Options {
  return {
    ruleId: "test-rule", ruleHash: "hash", rulesFileCommit: "abc123", ruleSymbolCount: 1,
    ruleEvaluationIndex: 1, globalEvaluationIndex: 1, seed: 20260917, resamples: 1000,
    slippageBps: 5, unfilledCount: 0, symbols: [], historyCoverage: {},
    command: "backtest:daily --rule test-rule --mode holdout", now: 1_700_000_000_000,
    ...overrides,
  };
}

/** N trades on N distinct days (so decisionDaysWithTrades scales with closedTrades), all with
 *  the same rMultiple, all filled (so a large permutation always completes). */
function tradesOnDistinctDays(n: number, rMultiple: number): SimTrade[] {
  return Array.from({ length: n }, (_, i) =>
    trade({ decisionDay: `2026-01-${String((i % 28) + 1).padStart(2, "0")}-${Math.floor(i / 28)}`, rMultiple, exitTime: i }));
}

function fullPermutation(n: number, meanR: number): { meanRs: number[]; runsAttempted: number } {
  return { meanRs: Array.from({ length: n }, () => meanR), runsAttempted: n };
}

// ── AC-24 / step 2 ───────────────────────────────────────────────────────────────────────────

test("AC-24: 29 trades all at +1R -> insufficient_data (step 2)", () => {
  const trades = tradesOnDistinctDays(29, 1);
  const report = runGateD0(trades, fullPermutation(1000, 1), baseOpts());
  assert.equal(report.verdict, "insufficient_data");
  assert.match(report.verdictReason, /^step 2:/);
});

// ── AC-96 ────────────────────────────────────────────────────────────────────────────────────

test("AC-96: insufficient_data when decisionDaysWithTrades < 20 even with 40 closed trades", () => {
  // 40 trades crammed into 5 distinct days (8 per day).
  const trades = Array.from({ length: 40 }, (_, i) =>
    trade({ decisionDay: `2026-03-0${(i % 5) + 1}`, rMultiple: 1, exitTime: i }));
  const report = runGateD0(trades, fullPermutation(1000, 1), baseOpts());
  assert.equal(report.closedTrades, 40);
  assert.ok(report.decisionDaysWithTrades < 20);
  assert.equal(report.verdict, "insufficient_data");
  assert.match(report.verdictReason, /^step 2:/);
});

// ── step 2b ──────────────────────────────────────────────────────────────────────────────────

test("step 2b: permutationRunsCompleted < 900 -> insufficient_data even with otherwise-passing trades", () => {
  const trades = tradesOnDistinctDays(40, 1);
  const report = runGateD0(trades, fullPermutation(899, 1), baseOpts());
  assert.equal(report.permutationRunsCompleted, 899);
  assert.equal(report.verdict, "insufficient_data");
  assert.match(report.verdictReason, /^step 2b:/);
});

// ── AC-26 / step 4 ───────────────────────────────────────────────────────────────────────────

test("AC-26: 40 trades with meanR > 0 but bootstrap lower bound <= 0 -> no_edge (step 4)", () => {
  // Half the days at +10R, half at -9R: meanR is positive, but the bootstrap lower bound (5th
  // percentile of resampled means) dips to/below 0 because a resample can draw mostly losers.
  const trades: SimTrade[] = [];
  for (let i = 0; i < 20; i++) trades.push(trade({ decisionDay: `2026-04-${String(i + 1).padStart(2, "0")}`, rMultiple: 10, exitTime: i }));
  for (let i = 0; i < 20; i++) trades.push(trade({ decisionDay: `2026-05-${String(i + 1).padStart(2, "0")}`, rMultiple: -9, exitTime: 100 + i }));
  const report = runGateD0(trades, fullPermutation(1000, 0.5), baseOpts());
  assert.ok(report.meanR > 0, `expected meanR > 0, got ${report.meanR}`);
  assert.ok(report.bootstrapCi90[0] <= 0, `expected bootstrap lower bound <= 0, got ${report.bootstrapCi90[0]}`);
  assert.equal(report.verdict, "no_edge");
  assert.match(report.verdictReason, /^step 4:/);
});

// ── AC-25 ────────────────────────────────────────────────────────────────────────────────────

test("AC-25: identical inputs and seed -> two runGateD0 calls are deep-equal except generatedAt", () => {
  const trades = tradesOnDistinctDays(40, 1);
  const permutation = fullPermutation(1000, 1);
  const opts1 = baseOpts({ now: 111 });
  const opts2 = baseOpts({ now: 222 });
  const r1 = runGateD0(trades, permutation, opts1);
  const r2 = runGateD0(trades, permutation, opts2);
  assert.deepEqual({ ...r1, generatedAt: 0 }, { ...r2, generatedAt: 0 });
  assert.notEqual(r1.generatedAt, r2.generatedAt);
});

// ── AC-23 ────────────────────────────────────────────────────────────────────────────────────

test("AC-23: a ledger with 3 prior entries for ruleId -> 4th run still gets a full report, verdict holdout_exhausted, ruleEvaluationIndex 4", () => {
  const trades = tradesOnDistinctDays(40, 1);
  const report = runGateD0(trades, fullPermutation(1000, 1), baseOpts({ ruleEvaluationIndex: 4, globalEvaluationIndex: 4 }));
  assert.equal(report.ruleEvaluationIndex, 4);
  assert.equal(report.verdict, "holdout_exhausted");
  assert.match(report.verdictReason, /^step 1:/);
  // The report is still fully computed (not short-circuited) — AC-23's "still appends... before
  // simulating" is a CLI-level ordering concern; here we assert the pure function still returns
  // real stats rather than zeros/placeholders.
  assert.equal(report.closedTrades, 40);
});

// ── AC-92 ────────────────────────────────────────────────────────────────────────────────────

test("AC-92: global alpha — 2 ledger entries for rule a, 1 for rule b, rule c's first run gets ruleEvaluationIndex 1, globalEvaluationIndex 4, alpha 0.025", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-d0-ledger-"));
  const ledgerPath = join(dir, "holdout-ledger.jsonl");
  try {
    const entry = (ruleId: string): LedgerEntry => ({
      time: 1, ruleId, ruleHash: "h", rulesFileCommit: "c", command: "cmd",
      holdoutStart: HOLDOUT_START_MS, holdoutEnd: HOLDOUT_END_MS, seed: 1, slippageBps: 5,
    });
    appendLedger(ledgerPath, entry("a"));
    appendLedger(ledgerPath, entry("a"));
    appendLedger(ledgerPath, entry("b"));
    appendLedger(ledgerPath, entry("c")); // this run's own line, appended before simulating

    const entries = readLedger(ledgerPath);
    const rIdx = ruleEvaluationIndex(entries, "c");
    const gIdx = globalEvaluationIndex(entries);
    assert.equal(rIdx, 1);
    assert.equal(gIdx, 4);

    const trades = tradesOnDistinctDays(40, 1);
    const report = runGateD0(trades, fullPermutation(1000, 1), baseOpts({ ruleId: "c", ruleEvaluationIndex: rIdx, globalEvaluationIndex: gIdx }));
    assert.equal(report.alpha, 0.025);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── readLedger fail-closed ───────────────────────────────────────────────────────────────────

test("readLedger throws on an unparseable line instead of treating the file as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-d0-ledger-bad-"));
  const ledgerPath = join(dir, "holdout-ledger.jsonl");
  try {
    appendLedger(ledgerPath, {
      time: 1, ruleId: "a", ruleHash: "h", rulesFileCommit: "c", command: "cmd",
      holdoutStart: HOLDOUT_START_MS, holdoutEnd: HOLDOUT_END_MS, seed: 1, slippageBps: 5,
    });
    // Corrupt the file with a trailing unparseable line.
    appendFileSync(ledgerPath, "not json at all\n");
    assert.throws(() => readLedger(ledgerPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLedger returns an empty array for a missing file (no evaluations yet)", () => {
  assert.deepEqual(readLedger(join(tmpdir(), "does-not-exist-gate-d0-ledger.jsonl")), []);
});
