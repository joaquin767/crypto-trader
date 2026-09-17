// Gate D0 — specs/daily-catalyst-manual-trading.md §5.10 (canonical declarations) / §5.10a
// "Windows and leakage", "Ledger and multiple testing" (normative behavior).
//
// `runGateD0` is pure given its inputs (stats + ledger indices computed by the caller).
// `readLedger`/`appendLedger` are the only I/O in this module — the ledger line is appended
// BEFORE simulation starts (§5.10a), so a run that crashes mid-simulation still consumes budget;
// that ordering is the CLI's job (scripts/backtest-daily.ts), not this module's.

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { bootstrapCi90, clusterByDay, maxDrawdownR, permutationPValue, topSymbolShare } from "./stats.ts";
import type { SimTrade } from "./simulate.ts";

/** Fixed in code, not CLI-configurable (§5.10, §8.1). Changing either is a reviewed code change
 *  that requires moving the old ledger aside (§5.10a "Holdout mode"). */
export const HOLDOUT_START_MS = Date.parse("2025-09-16T00:00:00Z");
export const HOLDOUT_END_MS = Date.parse("2026-09-15T23:59:59.999Z");

export interface LedgerEntry {
  time: number;
  ruleId: string;
  ruleHash: string;
  rulesFileCommit: string;
  command: string;
  holdoutStart: number;
  holdoutEnd: number;
  seed: number;
  slippageBps: number;
}

export interface GateD0Report {
  schemaVersion: 2;
  generatedAt: number;
  command: string;
  ruleId: string;
  ruleHash: string;
  rulesFileCommit: string;
  holdoutStart: number;
  holdoutEnd: number;
  ruleEvaluationIndex: number;
  globalEvaluationIndex: number;
  alpha: number;
  closedTrades: number;
  decisionDaysWithTrades: number;
  meanR: number;
  bootstrapCi90: [number, number];
  permutationPValue: number;
  permutationRunsCompleted: number;
  topSymbolShare: number;
  maxDrawdownR: number;
  seed: number;
  slippageBps: number;
  unfilledCount: number;
  holdoutTradeR: number[];
  holdoutTradeDays: string[];
  symbols: { symbol: string; firstKlineTime: number }[];
  historyCoverage: Record<string, { from: number; to: number; rows: number }>;
  verdict: "edge_confirmed" | "no_edge" | "insufficient_data" | "holdout_exhausted" | "refused";
  verdictReason: string;
}

// ── Ledger I/O ───────────────────────────────────────────────────────────────────────────────

/** Reads every line of the JSONL ledger. Fails closed: ANY unparseable or malformed-shape line
 *  throws (never silently skipped, and the file is never treated as empty because of it) — a
 *  changed/corrupted ledger must block holdout runs rather than silently under-count budget.
 *  A missing file yields an empty array (no evaluations yet). */
export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`unparseable ledger line in "${path}": ${(err as Error).message} — line: ${line}`);
    }
    const e = parsed as Partial<LedgerEntry> | null;
    if (
      e === null || typeof e !== "object" ||
      typeof e.time !== "number" ||
      typeof e.ruleId !== "string" ||
      typeof e.ruleHash !== "string" ||
      typeof e.rulesFileCommit !== "string" ||
      typeof e.command !== "string" ||
      typeof e.holdoutStart !== "number" ||
      typeof e.holdoutEnd !== "number" ||
      typeof e.seed !== "number" ||
      typeof e.slippageBps !== "number"
    ) {
      throw new Error(`malformed ledger line in "${path}": ${line}`);
    }
    entries.push(e as LedgerEntry);
  }
  return entries;
}

/** Append-only, fsync-safe: opens in append mode, writes, fsyncs before closing, so a line that
 *  reports "appended" has actually reached disk before simulation starts (§5.10a). */
export function appendLedger(path: string, entry: LedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    // Ensure the file exists before opening for append+fsync below (also covers a directory
    // that was just created).
    appendFileSync(path, "");
  }
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 1-based count of ledger entries for `ruleId` (any hash), including the just-appended one when
 *  `entries` was re-read after appendLedger (§5.10a "Per-rule cap"). */
export function ruleEvaluationIndex(entries: readonly LedgerEntry[], ruleId: string): number {
  return entries.filter((e) => e.ruleId === ruleId).length;
}

/** 1-based count of ALL ledger entries for this holdout window, across every rule id
 *  (§5.10a "Global alpha"). */
export function globalEvaluationIndex(entries: readonly LedgerEntry[]): number {
  return entries.length;
}

// ── Pure verdict ─────────────────────────────────────────────────────────────────────────────

export interface RunGateD0Options {
  ruleId: string;
  ruleHash: string;
  rulesFileCommit: string;
  ruleSymbolCount: number;
  ruleEvaluationIndex: number;
  globalEvaluationIndex: number;
  seed: number;
  resamples: number;
  slippageBps: number;
  unfilledCount: number;
  symbols: GateD0Report["symbols"];
  historyCoverage: GateD0Report["historyCoverage"];
  command: string;
  now: number;
}

/**
 * Pure given its inputs. Verdict order (first match decides, §5.10):
 * 1. ruleEvaluationIndex > 3 -> holdout_exhausted
 * 2. closedTrades < 30 or decisionDaysWithTrades < 20 -> insufficient_data
 * 2b. permutationRunsCompleted < 900 -> insufficient_data
 * 3. meanR <= 0 -> no_edge
 * 4. bootstrapCi90[0] <= 0 -> no_edge
 * 5. permutationPValue > alpha -> no_edge
 * 6. topSymbolShare > 0.60 (only when ruleSymbolCount >= 2) -> no_edge
 * 7. maxDrawdownR > 10 -> no_edge
 * 8. else edge_confirmed
 */
export function runGateD0(
  trades: readonly SimTrade[],
  permutation: { meanRs: readonly number[]; runsAttempted: number },
  opts: RunGateD0Options,
): GateD0Report {
  const closedTrades = trades.length;
  const sortedByExit = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const decisionDaysWithTrades = clusterByDay(trades).length;
  const meanR = closedTrades > 0 ? trades.reduce((a, t) => a + t.rMultiple, 0) / closedTrades : 0;
  const ci90 = closedTrades > 0 ? bootstrapCi90(trades, opts.resamples, opts.seed) : ([0, 0] as [number, number]);
  const permutationRunsCompleted = permutation.meanRs.length;
  const pValue = permutationPValue(meanR, permutation.meanRs);
  const alpha = 0.1 / opts.globalEvaluationIndex;
  const topShare = topSymbolShare(trades);
  const maxDd = maxDrawdownR(trades);

  let verdict: GateD0Report["verdict"];
  let verdictReason: string;

  if (opts.ruleEvaluationIndex > 3) {
    verdict = "holdout_exhausted";
    verdictReason = `step 1: ruleEvaluationIndex=${opts.ruleEvaluationIndex} > 3 (holdout budget exhausted for this rule)`;
  } else if (closedTrades < 30 || decisionDaysWithTrades < 20) {
    verdict = "insufficient_data";
    verdictReason = `step 2: closedTrades=${closedTrades} (need >=30) or decisionDaysWithTrades=${decisionDaysWithTrades} (need >=20)`;
  } else if (permutationRunsCompleted < 900) {
    verdict = "insufficient_data";
    verdictReason = `step 2b: permutationRunsCompleted=${permutationRunsCompleted} < 900`;
  } else if (meanR <= 0) {
    verdict = "no_edge";
    verdictReason = `step 3: meanR=${meanR} <= 0`;
  } else if (ci90[0] <= 0) {
    verdict = "no_edge";
    verdictReason = `step 4: bootstrapCi90 lower bound=${ci90[0]} <= 0`;
  } else if (pValue > alpha) {
    verdict = "no_edge";
    verdictReason = `step 5: permutationPValue=${pValue} > alpha=${alpha}`;
  } else if (opts.ruleSymbolCount >= 2 && topShare > 0.6) {
    verdict = "no_edge";
    verdictReason = `step 6: topSymbolShare=${topShare} > 0.60`;
  } else if (maxDd > 10) {
    verdict = "no_edge";
    verdictReason = `step 7: maxDrawdownR=${maxDd} > 10`;
  } else {
    verdict = "edge_confirmed";
    verdictReason = "step 8: all checks passed";
  }

  return {
    schemaVersion: 2,
    generatedAt: opts.now,
    command: opts.command,
    ruleId: opts.ruleId,
    ruleHash: opts.ruleHash,
    rulesFileCommit: opts.rulesFileCommit,
    holdoutStart: HOLDOUT_START_MS,
    holdoutEnd: HOLDOUT_END_MS,
    ruleEvaluationIndex: opts.ruleEvaluationIndex,
    globalEvaluationIndex: opts.globalEvaluationIndex,
    alpha,
    closedTrades,
    decisionDaysWithTrades,
    meanR,
    bootstrapCi90: ci90,
    permutationPValue: pValue,
    permutationRunsCompleted,
    topSymbolShare: topShare,
    maxDrawdownR: maxDd,
    seed: opts.seed,
    slippageBps: opts.slippageBps,
    unfilledCount: opts.unfilledCount,
    holdoutTradeR: sortedByExit.map((t) => t.rMultiple),
    holdoutTradeDays: sortedByExit.map((t) => t.decisionDay),
    symbols: opts.symbols,
    historyCoverage: opts.historyCoverage,
    verdict,
    verdictReason,
  };
}
