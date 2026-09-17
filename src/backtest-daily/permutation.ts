// Exposure-matched permutation control — specs/daily-catalyst-manual-trading.md §5.10a
// "Permutation control (exposure-matched)".
//
// Pure: no I/O, no clock reads (the window/cutoff/seed are inputs). Reuses replay.ts's own bar
// and funding extraction (`historyBarsForSymbol`/`fundingRowsForSymbol`) and its
// buildFeatures/planTrade/simulatePlan pipeline stages, so the null distribution is built from
// exactly the same cost model and sizing algorithm as the observed trades — only the entry day
// is randomized, never re-evaluated against the rule's entry conditions (§5.10a: "The null
// therefore has the rule's own symbol mix, trade count and same-day clustering — only the timing
// is random"). `evaluateRule` is deliberately NOT called here: gating the random day on the
// rule's own trigger condition would make the control non-random and defeat its purpose.

import { buildFeatures, DEFAULT_STALENESS_MS } from "../research/features.ts";
import { instrumentFilters, planTrade } from "../research/planner.ts";
import type { PlannerConfig } from "../research/planner.ts";
import { ruleHash } from "../research/rules.ts";
import type { RuleDefinition, RuleOutcome } from "../research/rules.ts";
import type { HistoryFile } from "./history-store.ts";
import { featureSnapshotsAt, fundingRowsForSymbol, historyBarsForSymbol } from "./replay.ts";
import { mulberry32 } from "./stats.ts";
import type { SimTrade } from "./simulate.ts";
import { simulatePlan } from "./simulate.ts";

export interface PermutationOptions {
  rule: RuleDefinition;
  history: readonly HistoryFile[];
  plannerConfig: PlannerConfig;
  /** The observed backtest's filled trades — clusters (decision day -> symbol set) are derived
   *  from these, preserving the rule's own symbol mix, trade count and same-day clustering. */
  trades: readonly SimTrade[];
  /** Per-symbol eligible days from ReplayResult — a day is a candidate draw for a cluster only
   *  when it is eligible for EVERY symbol in that cluster. */
  eligibleDays: Readonly<Record<string, readonly string[]>>;
  cutoffMs: number;
  slippageBps: number;
  runs: number; // 1 000 (§8.1)
  seed: number;
}

export interface PermutationResult {
  meanRs: number[];
  runsAttempted: number;
  /** Distinct days actually drawn across all runs (sorted) — lets tests and artifacts confirm draws came only
   *  from fillable days. */
  drawnDays: string[];
}

interface ObservedCluster {
  day: string;
  symbols: string[];
}

function observedClustersOf(trades: readonly SimTrade[]): ObservedCluster[] {
  const byDay = new Map<string, Set<string>>();
  for (const t of trades) {
    const set = byDay.get(t.decisionDay) ?? new Set<string>();
    set.add(t.symbol);
    byDay.set(t.decisionDay, set);
  }
  return [...byDay.entries()].map(([day, symbols]) => ({ day, symbols: [...symbols] }));
}

function intersectEligibleDays(eligibleDays: Readonly<Record<string, readonly string[]>>, symbols: readonly string[]): string[] {
  if (symbols.length === 0) return [];
  const sets = symbols.map((s) => new Set(eligibleDays[s] ?? []));
  return (eligibleDays[symbols[0]!] ?? []).filter((d) => sets.every((s) => s.has(d)));
}

/**
 * Pure. §5.10a: 1 000 runs, each keeping the observed cluster structure exactly. For every
 * observed cluster, draw one holdout day uniformly from that cluster's FILLABLE days — eligible for
 * all its symbols, and for every symbol the planner returns a plan and the simulation fills — and
 * simulate those same symbols on that day with a plan built the same way (same side /
 * stopAtrMultiple / targetRMultiple / maxHoldDays / planner / costs). Observed trades only exist on
 * such days, so the null compares like with like. A cluster with no fillable day fails every run
 * (not counted in `meanRs`, counted in `runsAttempted`) — fail closed.
 */
export function runPermutation(opts: PermutationOptions): PermutationResult {
  const { rule, history, plannerConfig, trades, eligibleDays, cutoffMs, slippageBps, runs, seed } = opts;
  const clusters = observedClustersOf(trades);
  const rng = mulberry32(seed);
  const hash = ruleHash(rule);

  const barsBySymbol = new Map<string, ReturnType<typeof historyBarsForSymbol>>();
  const fundingBySymbol = new Map<string, ReturnType<typeof fundingRowsForSymbol>>();
  for (const symbol of rule.symbols) {
    barsBySymbol.set(symbol, historyBarsForSymbol(history, symbol, cutoffMs));
    fundingBySymbol.set(symbol, fundingRowsForSymbol(history, symbol, cutoffMs));
  }

  // Candidate days per cluster's exact symbol set, computed once (clusters are fixed across
  // runs — only which day is drawn from them varies).
  const candidatesByCluster = clusters.map((c) => intersectEligibleDays(eligibleDays, c.symbols));

  // (day, symbol) -> its plan+simulation result, or null if rejected/unfilled. The same day is
  // typically redrawn many times across 1 000 runs x up to 5 attempts, and the result is a pure
  // function of (day, symbol, history, rule, plannerConfig, cutoffMs) — none of which change
  // across draws — so memoizing here turns a run-count-sized cost into an eligible-days-sized
  // one (found necessary running the Phase 4b smoke test: an un-memoized version took minutes
  // per rule on the real backfilled history).
  const simCache = new Map<string, SimTrade | null>();

  // Point-in-time snapshots (which hash their rows) are the expensive part and are identical for every symbol on
  // a day, so features and instrument filters are built once per day for all rule symbols. Fillable-day
  // precomputation touches every eligible day, which made per-(day, symbol) rebuilding take minutes per rule.
  const dayCache = new Map<string, { instruments: ReturnType<typeof instrumentFilters>; fvBySymbol: Map<string, ReturnType<typeof buildFeatures>[number]> }>();
  function dayInputs(day: string, decisionTime: number) {
    const known = dayCache.get(day);
    if (known !== undefined) return known;
    const snapshots = featureSnapshotsAt(history, decisionTime);
    const fvs = buildFeatures(snapshots, rule.symbols, decisionTime, DEFAULT_STALENESS_MS);
    const value = { instruments: instrumentFilters(snapshots, rule.symbols), fvBySymbol: new Map(fvs.map((fv) => [fv.symbol, fv])) };
    dayCache.set(day, value);
    return value;
  }

  function simulateOne(day: string, symbol: string): SimTrade | null {
    const key = `${day}|${symbol}`;
    const cached = simCache.get(key);
    if (cached !== undefined) return cached;

    const decisionTime = Date.parse(`${day}T00:15:00Z`);
    const { instruments, fvBySymbol } = dayInputs(day, decisionTime);
    const fv = fvBySymbol.get(symbol);
    // Synthesized "triggered" outcome: the permutation control forces entry with the rule's own
    // side/sizing on a random day — it never re-checks entryWhenAll (see file header).
    const outcome: Extract<RuleOutcome, { result: "triggered" }> = {
      ruleId: rule.id, ruleHash: hash, symbol, result: "triggered", evidence: {},
    };
    const plan = planTrade(outcome, rule, fv!, plannerConfig, 0, false, day, 0, true, instruments[symbol] ?? null, decisionTime);

    let result: SimTrade | null = null;
    if (plan.kind === "plan") {
      const bars = barsBySymbol.get(symbol) ?? [];
      const funding = fundingBySymbol.get(symbol) ?? [];
      const sim = simulatePlan(plan, bars, funding, rule.maxHoldDays, slippageBps, cutoffMs);
      if (!("kind" in sim && sim.kind === "unfilled")) result = sim as SimTrade;
    }
    simCache.set(key, result);
    return result;
  }

  // Fillable days per distinct symbol set, computed once before any run. Iterating candidate days in order
  // (not via the RNG) keeps the draw sequence identical for the same seed regardless of how many days fill.
  const fillableBySymbolSet = new Map<string, string[]>();
  const fillableByCluster = clusters.map((c, ci) => {
    const setKey = [...c.symbols].sort().join(",");
    const known = fillableBySymbolSet.get(setKey);
    if (known !== undefined) return known;
    const fillable = candidatesByCluster[ci]!.filter((day) => c.symbols.every((symbol) => simulateOne(day, symbol) !== null));
    fillableBySymbolSet.set(setKey, fillable);
    return fillable;
  });

  const meanRs: number[] = [];
  const drawn = new Set<string>();
  let runsAttempted = 0;

  for (let run = 0; run < runs; run++) {
    runsAttempted++;
    const runTrades: SimTrade[] = [];
    let runFailed = clusters.length === 0;

    for (let ci = 0; ci < clusters.length && !runFailed; ci++) {
      const fillable = fillableByCluster[ci]!;
      if (fillable.length === 0) {
        runFailed = true;
        break;
      }
      const day = fillable[Math.floor(rng() * fillable.length)]!;
      drawn.add(day);
      for (const symbol of clusters[ci]!.symbols) {
        // Non-null by construction: the day was kept only if every symbol of this set fills (memoized).
        runTrades.push(simulateOne(day, symbol)!);
      }
    }

    if (runFailed) continue;
    const meanR = runTrades.reduce((a, t) => a + t.rMultiple, 0) / runTrades.length;
    meanRs.push(meanR);
  }

  return { meanRs, runsAttempted, drawnDays: [...drawn].sort() };
}
