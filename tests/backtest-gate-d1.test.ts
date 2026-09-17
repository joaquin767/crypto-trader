// Gate D1 tests — specs/daily-catalyst-manual-trading.md §5.10 / §5.10a "d1-check",
// AC-26a..g, AC-88, AC-89.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseExplainedDates, ruleFeatureSourceIds, runGateD1, selectD0HoldoutArtifact,
  selectPaperTradesForRule, unexplainedIncompleteDays,
} from "../src/backtest-daily/gate-d1.ts";
import type { D1Review, DayReportSummary, RunGateD1Options } from "../src/backtest-daily/gate-d1.ts";
import type { GateD0Report } from "../src/backtest-daily/gate-d0.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import type { RuleDefinition } from "../src/research/rules.ts";
import type { SourceId } from "../src/research/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function review(overrides: Partial<D1Review> = {}): D1Review {
  return {
    tradeId: "t", ruleId: "rule-a", ruleHash: "hash-a", origin: "rules-file", aiStanceAtPlan: null,
    plannedRiskUsd: 10, netPnlUsd: 3, feesUsd: 0, fundingUsd: 0, rMultiple: 0.3,
    entrySlippagePct: null, sizeDeviationPct: null, maePct: 0, mfePct: 0,
    exitKind: "time", followedPlan: true, venue: "paper",
    ...overrides,
  };
}

function makeReviews(n: number, rMultiple: number, followedCount: number): D1Review[] {
  return Array.from({ length: n }, (_, i) => review({ tradeId: `t${i}`, rMultiple, followedPlan: i < followedCount }));
}

function makeD0Holdout(n: number, r: number): { r: number[]; days: string[] } {
  return {
    r: Array.from({ length: n }, () => r),
    days: Array.from({ length: n }, (_, i) => `2025-10-${String((i % 28) + 1).padStart(2, "0")}`),
  };
}

const NOW = Date.UTC(2026, 0, 1);

function baseOpts(overrides: Partial<RunGateD1Options> = {}): RunGateD1Options {
  return {
    ruleId: "rule-a", ruleHash: "hash-a", forwardOnly: false,
    firstPaperEntryTime: NOW - 46 * DAY_MS, now: NOW,
    d0Holdout: makeD0Holdout(40, 0.05),
    unexplainedIncompleteDays: 0,
    seed: 20260917, resamples: 200, command: "backtest:daily --rule rule-a --mode d1-check",
    ...overrides,
  };
}

// ── AC-26a ───────────────────────────────────────────────────────────────────────────────────

test("AC-26a: 30 paper reviews over 46 days, expectancyR 0.30, adherenceRate ~0.93, d0Block30P10 0.05, 0 unexplained -> paper_passed", () => {
  const reviews = makeReviews(30, 0.3, 28); // 28/30 ~= 0.933
  const report = runGateD1(reviews, baseOpts());
  assert.ok(Math.abs(report.expectancyR! - 0.3) < 1e-9);
  assert.ok(Math.abs(report.d0Block30P10! - 0.05) < 1e-9);
  assert.ok(report.adherenceRate! >= 0.9);
  assert.equal(report.verdict, "paper_passed");
});

// ── AC-26b ───────────────────────────────────────────────────────────────────────────────────

test("AC-26b: 29 reviews (below minTrades) -> not_yet (step 2)", () => {
  const reviews = makeReviews(29, 0.3, 27);
  const report = runGateD1(reviews, baseOpts());
  assert.equal(report.verdict, "not_yet");
  assert.match(report.verdictReason, /^step 2:/);
});

test("AC-26b: 44 calendar days (below 45) -> not_yet (step 2)", () => {
  const reviews = makeReviews(30, 0.3, 28);
  const report = runGateD1(reviews, baseOpts({ firstPaperEntryTime: NOW - 44 * DAY_MS }));
  assert.equal(report.verdict, "not_yet");
  assert.match(report.verdictReason, /^step 2:/);
});

// ── AC-26c ───────────────────────────────────────────────────────────────────────────────────

test("AC-26c: adherenceRate below 0.90 -> failed (step 5) regardless of expectancy", () => {
  const reviews = makeReviews(30, 0.3, 25); // 25/30 ~= 0.833
  const report = runGateD1(reviews, baseOpts());
  assert.ok(report.adherenceRate! < 0.9);
  assert.equal(report.verdict, "failed");
  assert.match(report.verdictReason, /^step 5:/);
});

// ── AC-26d ───────────────────────────────────────────────────────────────────────────────────

test("AC-26d: expectancyR 0.02 < d0Block30P10 0.05 -> failed (step 4)", () => {
  const reviews = makeReviews(30, 0.02, 28);
  const report = runGateD1(reviews, baseOpts());
  assert.ok(Math.abs(report.expectancyR! - 0.02) < 1e-9);
  assert.ok(Math.abs(report.d0Block30P10! - 0.05) < 1e-9);
  assert.equal(report.verdict, "failed");
  assert.match(report.verdictReason, /^step 4:/);
});

// ── AC-26e ───────────────────────────────────────────────────────────────────────────────────

test("AC-26e: forwardOnly=true with 45 reviews (below the 60-trade minimum) -> not_yet", () => {
  const reviews = makeReviews(45, 0.3, 42);
  const report = runGateD1(reviews, baseOpts({ forwardOnly: true, d0Holdout: null }));
  assert.equal(report.verdict, "not_yet");
});

test("AC-26e: forwardOnly=true with 60 reviews -> paper_passed and d0Block30P10 === null", () => {
  const reviews = makeReviews(60, 0.3, 56); // 56/60 ~= 0.933
  const report = runGateD1(reviews, baseOpts({ forwardOnly: true, d0Holdout: null }));
  assert.equal(report.verdict, "paper_passed");
  assert.equal(report.d0Block30P10, null);
});

// ── AC-26f ───────────────────────────────────────────────────────────────────────────────────

test("AC-26f: a review with venue bybit-live throws", () => {
  const reviews = [...makeReviews(30, 0.3, 28), review({ tradeId: "bad", venue: "bybit-live" })];
  assert.throws(() => runGateD1(reviews, baseOpts()));
});

test("AC-26f: a review with a different ruleId throws", () => {
  const reviews = [...makeReviews(30, 0.3, 28), review({ tradeId: "bad", ruleId: "other-rule" })];
  assert.throws(() => runGateD1(reviews, baseOpts()));
});

// ── AC-26g ───────────────────────────────────────────────────────────────────────────────────

test("AC-26g: forwardOnly=false and d0Holdout=null -> failed (step 1)", () => {
  const report = runGateD1([], baseOpts({ d0Holdout: null }));
  assert.equal(report.verdict, "failed");
  assert.match(report.verdictReason, /^step 1:/);
});

// ── AC-88 ────────────────────────────────────────────────────────────────────────────────────

function manualTrade(overrides: Partial<ManualTrade> = {}): ManualTrade {
  return {
    id: "m1", venue: "paper", symbol: "BTC/USDT", side: "long", planId: "p1",
    ruleId: "rule-a", ruleHash: "hash-a", plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [], exitFills: [], actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "closed", exitKind: "time", notes: "", createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

test("AC-88: selectPaperTradesForRule ignores trades whose ruleHash differs from the current rule", () => {
  const trades = [
    manualTrade({ id: "keep", ruleHash: "hash-a" }),
    manualTrade({ id: "stale-hash", ruleHash: "hash-old" }),
    manualTrade({ id: "wrong-venue", venue: "bybit-live" }),
    manualTrade({ id: "open", status: "open" }),
  ];
  const selected = selectPaperTradesForRule(trades, "rule-a", "hash-a");
  assert.deepEqual(selected.map((t) => t.id), ["keep"]);
});

test("AC-88: selectD0HoldoutArtifact ignores an edge_confirmed artifact with a different ruleHash", () => {
  function artifact(overrides: Partial<GateD0Report> = {}): GateD0Report {
    return {
      schemaVersion: 2, generatedAt: 0, command: "cmd", ruleId: "rule-a", ruleHash: "hash-a",
      rulesFileCommit: "c", holdoutStart: 0, holdoutEnd: 0, ruleEvaluationIndex: 1, globalEvaluationIndex: 1,
      alpha: 0.1, closedTrades: 40, decisionDaysWithTrades: 20, meanR: 0.1, bootstrapCi90: [0.01, 0.2],
      permutationPValue: 0.01, permutationRunsCompleted: 1000, topSymbolShare: 0.5, maxDrawdownR: 1,
      seed: 1, slippageBps: 5, unfilledCount: 0, holdoutTradeR: [], holdoutTradeDays: [], symbols: [],
      historyCoverage: {}, verdict: "edge_confirmed", verdictReason: "step 8: all checks passed",
      ...overrides,
    };
  }
  const artifacts = [artifact({ ruleHash: "hash-old", generatedAt: 100 }), artifact({ ruleHash: "hash-a", generatedAt: 50 })];
  const selected = selectD0HoldoutArtifact(artifacts, "hash-a");
  assert.equal(selected?.generatedAt, 50);

  const noMatch = selectD0HoldoutArtifact([artifact({ ruleHash: "hash-old" })], "hash-a");
  assert.equal(noMatch, null);
});

test("AC-88: no matching gate-d0 artifact -> d0Holdout null -> runGateD1 fails at step 1 (non-forwardOnly)", () => {
  const report = runGateD1(makeReviews(30, 0.3, 28), baseOpts({ d0Holdout: null }));
  assert.equal(report.verdict, "failed");
  assert.match(report.verdictReason, /^step 1:/);
});

// ── AC-89 ────────────────────────────────────────────────────────────────────────────────────

test("AC-89: unexplainedIncompleteDays — 5 days, 2 incomplete + 1 missing, 1 of those 3 explained -> 2", () => {
  const days: DayReportSummary[] = [
    { date: "2026-01-01", found: true, nonOkSources: [] }, // complete
    { date: "2026-01-02", found: true, nonOkSources: ["fear-greed"] }, // incomplete (relevant source)
    { date: "2026-01-03", found: true, nonOkSources: ["fear-greed"] }, // incomplete (relevant source), explained
    { date: "2026-01-04", found: false, nonOkSources: [] }, // missing report -> incomplete
    { date: "2026-01-05", found: true, nonOkSources: ["defillama-stablecoins"] }, // incomplete but IRRELEVANT source
  ];
  const relevantSources = new Set<SourceId>(["fear-greed"]);
  const explained = new Set(["2026-01-03"]);
  const count = unexplainedIncompleteDays(days, relevantSources, explained);
  assert.equal(count, 2);
});

test("ruleFeatureSourceIds derives SourceIds from entryWhenAll + invalidateWhenAny", () => {
  const rule: Pick<RuleDefinition, "entryWhenAll" | "invalidateWhenAny"> = {
    entryWhenAll: [{ feature: "fearGreed", op: ">", value: 0 }, { feature: "close", op: ">", value: 0 }],
    invalidateWhenAny: [{ feature: "hoursToNextFomc", op: "<", value: 24 }],
  };
  const ids = ruleFeatureSourceIds(rule);
  assert.deepEqual([...ids].sort(), ["bybit-klines-1d", "fear-greed", "macro-calendar-manual"].sort());
});

test("parseExplainedDates reads '- YYYY-MM-DD: reason' lines and ignores unrelated text", () => {
  const doc = [
    "# D1 explanations for rule-a",
    "",
    "- 2026-01-02: bybit outage, unrelated to this rule's features",
    "Some prose line that is not a dated entry",
    "- 2026-01-05: manual backfill delay",
  ].join("\n");
  assert.deepEqual([...parseExplainedDates(doc)].sort(), ["2026-01-02", "2026-01-05"]);
});

test("ai-analyst ids select trades whose full promptVersionHash starts with the id's 8-char hash; rules-file ids stay exact", () => {
  const full = "abcd1234" + "e".repeat(56);
  const base = { status: "closed", venue: "paper", ruleId: "ai-analyst-abcd1234" } as const;
  const trades = [
    { ...base, id: "t1", ruleHash: full },
    { ...base, id: "t2", ruleHash: "ffff0000" + "e".repeat(56) },
  ] as unknown as Parameters<typeof selectPaperTradesForRule>[0];
  assert.deepEqual(selectPaperTradesForRule(trades, "ai-analyst-abcd1234", "abcd1234", "prefix").map((t) => t.id), ["t1"]);
  assert.deepEqual(selectPaperTradesForRule(trades, "ai-analyst-abcd1234", "abcd1234").map((t) => t.id), []);
});
