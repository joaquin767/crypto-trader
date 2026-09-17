// Replay loop — specs/daily-catalyst-manual-trading.md §5.10a "Replay loop".
//
// Pure: no I/O, no clock reads (the window and cutoff are inputs). Re-uses the exact same
// pipeline stages a live day does (snapshotsAt -> buildFeatures -> evaluateRule -> planTrade ->
// simulatePlan), so a rule's backtest behavior can never silently diverge from its live behavior.

import { buildFeatures, DEFAULT_STALENESS_MS } from "../research/features.ts";
import { evaluateRule } from "../research/rules.ts";
import type { RuleDefinition, RuleOutcome } from "../research/rules.ts";
import { instrumentFilters, planTrade } from "../research/planner.ts";
import type { PlannerConfig } from "../research/planner.ts";
import type { SourceRow, SourceSnapshot } from "../research/types.ts";
import type { HistoryFile } from "./history-store.ts";
import { snapshotsAt } from "./history-store.ts";
import type { SimTrade } from "./simulate.ts";
import { simulatePlan } from "./simulate.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface ReplayOptions {
  rule: RuleDefinition;
  history: readonly HistoryFile[];
  plannerConfig: PlannerConfig;
  firstDecisionDay: string; // inclusive, UTC date
  lastDecisionDay: string; // inclusive, UTC date; decision time = <day>T00:15:00Z
  cutoffMs: number; // simulation may not read any 1h bar with t + 1h > cutoffMs
  slippageBps: number; // per side, default 5 (§8.1 costs + A21)
}

export interface ReplayResult {
  trades: SimTrade[];
  unfilled: { day: string; symbol: string; reason: string }[];
  outcomes: { day: string; symbol: string; result: RuleOutcome["result"] }[];
  eligibleDays: Record<string, string[]>;
}

function utcDays(firstDay: string, lastDay: string): string[] {
  const days: string[] = [];
  let cursor = Date.parse(`${firstDay}T00:00:00Z`);
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return days;
}

/** 1h bar open times for one symbol, sorted ascending, from the history file's raw rows. */
function symbolBarTimes(history: readonly HistoryFile[], symbol: string): number[] {
  const file = history.find((h) => h.sourceId === "bybit-klines-1h");
  if (!file) return [];
  const times = new Set<number>();
  for (const r of file.rows) {
    if (r.key === symbol && r.field === "close") times.add(r.observedFor);
  }
  return [...times].sort((a, b) => a - b);
}

/** One symbol's 1h bars, assembled from raw SourceRows, filtered to `availableAt <= cutoffMs`
 *  BEFORE any field is read (AC-84: a bar the simulation must not see is never touched at all).
 *  Exported so src/backtest-daily/permutation.ts's exposure-matched control can reuse the exact
 *  same bar/funding extraction replayRule uses, instead of re-deriving it (§5.10a "Permutation
 *  control"). */
export function historyBarsForSymbol(
  history: readonly HistoryFile[],
  symbol: string,
  cutoffMs: number,
): { t: number; o: number; h: number; l: number; c: number; v: number }[] {
  const file = history.find((h) => h.sourceId === "bybit-klines-1h");
  if (!file) return [];
  const byTime = new Map<number, { t: number; o?: number; h?: number; l?: number; c?: number; v?: number }>();
  for (const r of file.rows) {
    if (r.availableAt > cutoffMs) continue;
    if (r.key !== symbol) continue;
    const bar = byTime.get(r.observedFor) ?? { t: r.observedFor };
    if (r.field === "open") bar.o = r.value as number;
    else if (r.field === "high") bar.h = r.value as number;
    else if (r.field === "low") bar.l = r.value as number;
    else if (r.field === "close") bar.c = r.value as number;
    else if (r.field === "volume") bar.v = r.value as number;
    byTime.set(r.observedFor, bar);
  }
  const complete = [...byTime.values()].filter(
    (b): b is { t: number; o: number; h: number; l: number; c: number; v: number } =>
      b.o !== undefined && b.h !== undefined && b.l !== undefined && b.c !== undefined && b.v !== undefined,
  );
  complete.sort((a, b) => a.t - b.t);
  return complete;
}

/** One symbol's funding rows, filtered to `availableAt <= cutoffMs` (same reasoning as
 *  `historyBarsForSymbol`). Exported for permutation.ts. */
export function fundingRowsForSymbol(history: readonly HistoryFile[], symbol: string, cutoffMs: number): SourceRow[] {
  const fundingFile = history.find((h) => h.sourceId === "bybit-funding");
  return (fundingFile?.rows ?? []).filter((r) => r.availableAt <= cutoffMs && r.key === symbol && r.field === "fundingRate");
}

/** Point-in-time snapshots + instrument filters for a decision day, restricted to the sources
 *  `buildFeatures` actually reads (excludes bybit-klines-1h, which only feeds simulation, never
 *  a rule feature) so repeated calls — as permutation.ts makes, once per drawn day per run — stay
 *  cheap even over a multi-year 1h history. Exported for permutation.ts. */
export function featureSnapshotsAt(history: readonly HistoryFile[], decisionTime: number): SourceSnapshot[] {
  return snapshotsAt(history.filter((h) => h.sourceId !== "bybit-klines-1h"), decisionTime);
}

/** A day is eligible for a symbol when its 1h bars cover decisionTime through
 *  decisionTime + maxHoldDays*24h, without a gap, and that horizon is within cutoffMs
 *  (§5.10a "eligibleDays" — used by the permutation control, Phase 4b). */
function isDayEligible(sortedBarTimes: readonly number[], decisionTime: number, maxHoldDays: number, cutoffMs: number): boolean {
  const boundary = decisionTime + maxHoldDays * DAY_MS;
  if (boundary > cutoffMs) return false;
  const barTimeSet = new Set(sortedBarTimes);
  let idx = sortedBarTimes.findIndex((t) => t >= decisionTime);
  if (idx === -1) return false;
  let cursor = sortedBarTimes[idx]!;
  while (cursor + HOUR_MS <= boundary) {
    const next = cursor + HOUR_MS;
    if (!barTimeSet.has(next)) return false;
    cursor = next;
  }
  return true;
}

/**
 * Pure. For each decision day and each rule symbol: snapshotsAt -> buildFeatures -> evaluateRule
 * -> planTrade (openTradeCount 0, breaker not tripped, liveClosedTradesForRule 0,
 * ladderResetByBreaker true, instrument from history) -> simulatePlan. One open simulated trade
 * per rule+symbol: a trigger while that symbol's previous sim trade is still open is skipped
 * (recorded as unfilled "position already open").
 */
export function replayRule(opts: ReplayOptions): ReplayResult {
  const { rule, history, plannerConfig, cutoffMs, slippageBps } = opts;
  const days = utcDays(opts.firstDecisionDay, opts.lastDecisionDay);

  const trades: SimTrade[] = [];
  const unfilled: ReplayResult["unfilled"] = [];
  const outcomes: ReplayResult["outcomes"] = [];

  // Symbol -> exitTime of that symbol's currently-open sim trade, or undefined if flat.
  const openUntil = new Map<string, number>();
  const fundingBySymbol = new Map<string, SourceRow[]>();
  const barsBySymbol = new Map<string, ReturnType<typeof historyBarsForSymbol>>();

  for (const symbol of rule.symbols) {
    barsBySymbol.set(symbol, historyBarsForSymbol(history, symbol, cutoffMs));
    fundingBySymbol.set(symbol, fundingRowsForSymbol(history, symbol, cutoffMs));
  }

  const eligibleDays: Record<string, string[]> = {};
  for (const symbol of rule.symbols) {
    const times = symbolBarTimes(history, symbol);
    eligibleDays[symbol] = days.filter((day) =>
      isDayEligible(times, Date.parse(`${day}T00:15:00Z`), rule.maxHoldDays, cutoffMs),
    );
  }

  for (const day of days) {
    const decisionTime = Date.parse(`${day}T00:15:00Z`);
    const snapshots = snapshotsAt(history, decisionTime);
    const instruments = instrumentFilters(snapshots, rule.symbols);

    for (const symbol of rule.symbols) {
      const stillOpen = openUntil.get(symbol);
      if (stillOpen !== undefined && stillOpen > decisionTime) {
        unfilled.push({ day, symbol, reason: "position already open" });
        continue;
      }

      const [fv] = buildFeatures(snapshots, [symbol], decisionTime, DEFAULT_STALENESS_MS);
      const outcome = evaluateRule(rule, fv!);
      outcomes.push({ day, symbol, result: outcome.result });
      if (outcome.result !== "triggered") continue;

      const plan = planTrade(
        outcome,
        rule,
        fv!,
        plannerConfig,
        0, // openTradeCount — Gate D0 measures one rule in isolation (A22)
        false, // breakerTripped
        day,
        0, // liveClosedTradesForRule
        true, // ladderResetByBreaker
        instruments[symbol] ?? null,
        decisionTime,
      );

      if (plan.kind === "rejected") {
        unfilled.push({ day, symbol, reason: plan.reason });
        continue;
      }

      const bars = barsBySymbol.get(symbol) ?? [];
      const funding = fundingBySymbol.get(symbol) ?? [];
      const sim = simulatePlan(plan, bars, funding, rule.maxHoldDays, slippageBps, cutoffMs);
      if ("kind" in sim && sim.kind === "unfilled") {
        // Bars past cutoffMs were removed before simulating (leakage protection), so the simulator only sees
        // "ran out of bars". Name the real cause when the hold window itself reaches past the cutoff.
        const holdEnd = decisionTime + rule.maxHoldDays * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
        const reason = holdEnd > cutoffMs && !sim.reason.includes("cutoff") ? `cutoff: hold window extends beyond cutoffMs (${sim.reason})` : sim.reason;
        unfilled.push({ day, symbol, reason });
        continue;
      }

      const trade = sim as SimTrade;
      trades.push(trade);
      openUntil.set(symbol, trade.exitTime);
    }
  }

  return { trades, unfilled, outcomes, eligibleDays };
}
