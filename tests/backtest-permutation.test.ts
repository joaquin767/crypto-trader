// runPermutation tests — specs/daily-catalyst-manual-trading.md §5.10a "Permutation control
// (exposure-matched)", AC-94, cutoff respected.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runPermutation } from "../src/backtest-daily/permutation.ts";
import { featureSnapshotsAt } from "../src/backtest-daily/replay.ts";
import type { HistoryFile } from "../src/backtest-daily/history-store.ts";
import { instrumentFilters, planTrade } from "../src/research/planner.ts";
import type { PlannerConfig } from "../src/research/planner.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import { ruleHash } from "../src/research/rules.ts";
import type { RuleDefinition, RuleOutcome } from "../src/research/rules.ts";
import { simulatePlan } from "../src/backtest-daily/simulate.ts";
import type { SimTrade } from "../src/backtest-daily/simulate.ts";
import type { SourceRow } from "../src/research/types.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const CFG: PlannerConfig = {
  maxCapitalUsd: 100, riskPerTradePercent: 1, maxLeverage: 5, liveLadderCap: 2,
  marginBudgetPercent: 25, maintenanceMarginRate: 0.005, minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11, maxOpenManualTrades: 3,
};

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "perm-rule", version: 1, description: "d", evidence: ["X1"], status: "experimental",
    symbols: ["A", "B"], side: "long",
    entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
    stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 2, forwardOnly: false, origin: "rules-file",
    ...overrides,
  };
}

/** Flat daily bars (constant close, so return1d/return7d are 0) with a symbol-specific
 *  high-low range so ATR (and therefore rMultiple) differs between A and B. */
function dailyHistory(symbol: string, range: number, fromMs: number, toMs: number): SourceRow[] {
  const rows: SourceRow[] = [];
  for (let t = fromMs; t <= toMs; t += DAY) {
    const availableAt = t + DAY;
    rows.push(
      { key: symbol, observedFor: t, availableAt, field: "open", value: 60000 },
      { key: symbol, observedFor: t, availableAt, field: "high", value: 60000 + range / 2 },
      { key: symbol, observedFor: t, availableAt, field: "low", value: 60000 - range / 2 },
      { key: symbol, observedFor: t, availableAt, field: "close", value: 60000 },
      { key: symbol, observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  }
  return rows;
}

/** Flat hourly bars (never touch stop/target -> always a clean time exit). */
function hourlyHistory(symbol: string, fromMs: number, toMs: number): SourceRow[] {
  const rows: SourceRow[] = [];
  for (let t = fromMs; t <= toMs; t += HOUR) {
    const availableAt = t + HOUR;
    rows.push(
      { key: symbol, observedFor: t, availableAt, field: "open", value: 60000 },
      { key: symbol, observedFor: t, availableAt, field: "high", value: 60000 },
      { key: symbol, observedFor: t, availableAt, field: "low", value: 60000 },
      { key: symbol, observedFor: t, availableAt, field: "close", value: 60000 },
      { key: symbol, observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  }
  return rows;
}

function fundingHistory(symbol: string, fromMs: number, toMs: number): SourceRow[] {
  const rows: SourceRow[] = [];
  for (let t = fromMs; t <= toMs; t += 8 * HOUR) rows.push({ key: symbol, observedFor: t, availableAt: t, field: "fundingRate", value: 0 });
  return rows;
}

function instrumentRows(symbol: string): SourceRow[] {
  return [
    { key: symbol, observedFor: 0, availableAt: 0, field: "minOrderQty", value: 0.0001 },
    { key: symbol, observedFor: 0, availableAt: 0, field: "qtyStep", value: 0.0001 },
    { key: symbol, observedFor: 0, availableAt: 0, field: "minNotionalValue", value: 5 },
  ];
}

function buildHistory(dailyFrom: number, hourlyFrom: number, hourlyTo: number): HistoryFile[] {
  return [
    {
      sourceId: "bybit-klines-1d", builtAt: 0, coverage: { from: dailyFrom, to: hourlyTo },
      rows: [...dailyHistory("A", 1000, dailyFrom, hourlyTo), ...dailyHistory("B", 2000, dailyFrom, hourlyTo)],
    },
    {
      sourceId: "bybit-klines-1h", builtAt: 0, coverage: { from: hourlyFrom, to: hourlyTo },
      rows: [...hourlyHistory("A", hourlyFrom, hourlyTo), ...hourlyHistory("B", hourlyFrom, hourlyTo)],
    },
    {
      sourceId: "bybit-funding", builtAt: 0, coverage: { from: hourlyFrom, to: hourlyTo },
      rows: [...fundingHistory("A", hourlyFrom - 8 * HOUR, hourlyTo + DAY), ...fundingHistory("B", hourlyFrom - 8 * HOUR, hourlyTo + DAY)],
    },
    {
      sourceId: "bybit-instruments", builtAt: 0, coverage: { from: 0, to: 0 },
      rows: [...instrumentRows("A"), ...instrumentRows("B")],
    },
  ];
}

/** The exact plan+simulation permutation.ts's internals would produce for `symbol` on `day`
 *  (same synthesized-trigger recipe as src/backtest-daily/permutation.ts). */
function referenceSim(r: RuleDefinition, history: HistoryFile[], symbol: string, day: string, cutoffMs: number): SimTrade {
  const decisionTime = Date.parse(`${day}T00:15:00Z`);
  const snapshots = featureSnapshotsAt(history, decisionTime);
  const instruments = instrumentFilters(snapshots, r.symbols);
  const [fv] = buildFeatures(snapshots, [symbol], decisionTime, DEFAULT_STALENESS_MS);
  const outcome: Extract<RuleOutcome, { result: "triggered" }> = {
    ruleId: r.id, ruleHash: ruleHash(r), symbol, result: "triggered", evidence: {},
  };
  const plan = planTrade(outcome, r, fv!, CFG, 0, false, day, 0, true, instruments[symbol] ?? null, decisionTime);
  assert.equal(plan.kind, "plan", `expected a fillable plan for ${symbol} on ${day}`);
  const bars = history.find((h) => h.sourceId === "bybit-klines-1h")!.rows
    .filter((row) => row.key === symbol && row.availableAt <= cutoffMs);
  // Reuse the same bar-assembly convention as replay.ts/permutation.ts.
  const byTime = new Map<number, { t: number; o?: number; h?: number; l?: number; c?: number; v?: number }>();
  for (const row of bars) {
    const b = byTime.get(row.observedFor) ?? { t: row.observedFor };
    (b as Record<string, number>)[row.field === "open" ? "o" : row.field === "high" ? "h" : row.field === "low" ? "l" : row.field === "close" ? "c" : "v"] = row.value as number;
    byTime.set(row.observedFor, b);
  }
  const klines = [...byTime.values()].sort((a, b) => a.t - b.t) as { t: number; o: number; h: number; l: number; c: number; v: number }[];
  const funding = history.find((h) => h.sourceId === "bybit-funding")!.rows.filter((row) => row.key === symbol && row.availableAt <= cutoffMs);
  const sim = simulatePlan(plan as Extract<typeof plan, { kind: "plan" }>, klines, funding, r.maxHoldDays, 0, cutoffMs);
  assert.ok(!("kind" in sim && sim.kind === "unfilled"), `expected a filled trade for ${symbol} on ${day}`);
  return sim as SimTrade;
}

function observedTrade(day: string, symbol: string): SimTrade {
  return {
    planId: `${day}:perm-rule:${symbol}`, ruleId: "perm-rule", symbol, decisionDay: day,
    entryTime: 0, exitTime: 0, entryPrice: 60000, exitPrice: 60000, exitKind: "time",
    netPnlUsd: 0, riskUsd: 1, rMultiple: 0, fundingUsd: 0, feesUsd: 0,
  };
}

test("AC-94: exposure-matched permutation preserves observed clusters [{A},{A},{A,B}] — every run simulates A x3 and B x1", () => {
  const dailyFrom = Date.UTC(2026, 0, 1);
  const hourlyFrom = Date.UTC(2026, 5, 1);
  const hourlyTo = hourlyFrom + 20 * DAY;
  const history = buildHistory(dailyFrom, hourlyFrom, hourlyTo);

  const candidateDays = ["2026-06-05", "2026-06-06", "2026-06-07"];
  const eligibleDays = { A: candidateDays, B: candidateDays };
  // Precondition AC-94 calls out explicitly: the {A,B} cluster's day pool is eligible for BOTH symbols.
  assert.deepEqual(eligibleDays.A, eligibleDays.B);

  const trades = [
    observedTrade("2026-03-01", "A"),
    observedTrade("2026-03-02", "A"),
    observedTrade("2026-03-03", "A"),
    observedTrade("2026-03-03", "B"),
  ];

  const cutoffMs = hourlyTo;
  const r = rule();
  const result = runPermutation({
    rule: r, history, plannerConfig: CFG, trades, eligibleDays, cutoffMs,
    slippageBps: 0, runs: 40, seed: 20260917,
  });

  assert.equal(result.runsAttempted, 40);
  assert.equal(result.meanRs.length, 40, "every run should complete: the fixture data fills on the first draw every time");

  // Deterministic system (flat prices, same instrument config every candidate day) -> every
  // run's mean should be identical, which is only possible if the SAME composition (3 A + 1 B)
  // is drawn every single time.
  const rounded = result.meanRs.map((m) => Number(m.toFixed(9)));
  assert.ok(rounded.every((m) => m === rounded[0]), "expected every run to produce the same mean R (fixed composition)");

  const rA = referenceSim(r, history, "A", candidateDays[0]!, cutoffMs).rMultiple;
  const rB = referenceSim(r, history, "B", candidateDays[0]!, cutoffMs).rMultiple;
  const expectedMean = (3 * rA + rB) / 4;
  assert.ok(
    Math.abs(rounded[0]! - expectedMean) < 1e-6,
    `expected mean ${expectedMean} (3xA + 1xB)/4, got ${rounded[0]}`,
  );
});

test("permutation never uses a 1h bar beyond cutoffMs — a poisoned history that throws on out-of-window access still completes", () => {
  const dailyFrom = Date.UTC(2026, 0, 1);
  const hourlyFrom = Date.UTC(2026, 5, 1);
  const cutoffMs = hourlyFrom + 3 * DAY; // well short of covering a 2-day hold from most candidate days
  const hourlyTo = hourlyFrom + 20 * DAY;
  const history = buildHistory(dailyFrom, hourlyFrom, hourlyTo);

  const klinesFile = history.find((h) => h.sourceId === "bybit-klines-1h")!;
  const poisoned = klinesFile.rows.map((r) => {
    if (r.availableAt <= cutoffMs) return r;
    const safe = { key: r.key, observedFor: r.observedFor, availableAt: r.availableAt, field: r.field };
    Object.defineProperty(safe, "value", {
      enumerable: true,
      get(): never {
        throw new Error(`accessed .value of a row beyond cutoffMs (availableAt=${r.availableAt})`);
      },
    });
    return safe as SourceRow;
  });
  const poisonedHistory = history.map((h) => (h.sourceId === "bybit-klines-1h" ? { ...h, rows: poisoned } : h));

  const candidateDays = ["2026-06-01", "2026-06-02"]; // decision time + 2-day hold can reach past cutoffMs
  const trades = [observedTrade("2026-03-01", "A")];

  assert.doesNotThrow(() => {
    runPermutation({
      rule: rule({ symbols: ["A"] }), history: poisonedHistory, plannerConfig: CFG,
      trades, eligibleDays: { A: candidateDays }, cutoffMs, slippageBps: 0, runs: 10, seed: 1,
    });
  });
});
