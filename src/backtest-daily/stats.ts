// Statistics — specs/daily-catalyst-manual-trading.md §5.10a "Statistics".
//
// Pure: no I/O, no clock reads. Every random draw goes through `mulberry32`, seeded explicitly
// by the caller (default DEFAULT_SEED, recorded in every artifact) so a report is exactly
// reproducible given the same trades and seed (AC-25).
//
// Day-clustering (not per-trade i.i.d. resampling) runs through every statistic here: trades
// opened on the same decision day share that day's market-wide features and are correlated, so
// resampling individual trades would understate uncertainty (§5.10a).

import { percentile } from "../strategy/walkforward.ts";
import type { SimTrade } from "./simulate.ts";

export const DEFAULT_SEED = 20260917;

/**
 * mulberry32 PRNG. Returns a function producing floats in [0, 1). Standard public-domain
 * implementation (no seeded PRNG previously existed in this repo — §5.10a evidence).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Groups anything with a `decisionDay` and `rMultiple` (SimTrade, or a synthesized
 * {decisionDay, rMultiple} pair) into one number[] of R values per decision day. A cluster is
 * all trades opened from the same decision day (§5.10a "Clusters").
 */
export function clusterByDay<T extends { decisionDay: string; rMultiple: number }>(
  trades: readonly T[],
): number[][] {
  const byDay = new Map<string, number[]>();
  for (const t of trades) {
    const arr = byDay.get(t.decisionDay) ?? [];
    arr.push(t.rMultiple);
    byDay.set(t.decisionDay, arr);
  }
  return [...byDay.values()];
}

/**
 * Day-clustered bootstrap CI90 (§5.10a "Bootstrap"): `resamples` times, draw as many clusters as
 * observed, with replacement, and take the mean R over all trades in the drawn clusters. CI90 is
 * [percentile(means, 0.05), percentile(means, 0.95)].
 */
export function bootstrapCi90(trades: readonly SimTrade[], resamples: number, seed: number): [number, number] {
  const clusters = clusterByDay(trades);
  if (clusters.length === 0) return [0, 0];
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    let n = 0;
    for (let c = 0; c < clusters.length; c++) {
      const cluster = clusters[Math.floor(rng() * clusters.length)]!;
      sum += cluster.reduce((a, b) => a + b, 0);
      n += cluster.length;
    }
    means.push(n > 0 ? sum / n : 0);
  }
  return [percentile(means, 0.05), percentile(means, 0.95)];
}

/**
 * Gate D1's 30-trade block bootstrap of the D0 holdout R distribution (§5.10a "d1-check",
 * §8.2): `resamples` times, draw whole decision-day clusters (same grouping as the D0 bootstrap)
 * with replacement until at least 30 trades are drawn, take the mean, and return the 10th
 * percentile of those means. Never per-trade i.i.d.
 */
export function d0Block30P10(
  d0Holdout: { r: readonly number[]; days: readonly string[] },
  resamples: number,
  seed: number,
): number {
  const paired = d0Holdout.r.map((r, i) => ({ decisionDay: d0Holdout.days[i]!, rMultiple: r }));
  const clusters = clusterByDay(paired);
  if (clusters.length === 0) return 0;
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const drawn: number[] = [];
    while (drawn.length < 30) {
      const cluster = clusters[Math.floor(rng() * clusters.length)]!;
      drawn.push(...cluster);
    }
    means.push(drawn.reduce((a, b) => a + b, 0) / drawn.length);
  }
  return percentile(means, 0.1);
}

/**
 * Permutation control p-value (§5.10a "Permutation control"):
 * `p = (1 + #{completed runs with meanR >= observed}) / (1 + completedRuns)`.
 */
export function permutationPValue(observedMeanR: number, runMeanRs: readonly number[]): number {
  const k = runMeanRs.filter((r) => r >= observedMeanR).length;
  return (1 + k) / (1 + runMeanRs.length);
}

/**
 * Concentration (§5.10a "Concentration"): the positive-P&L definition of
 * src/strategy/walkforward.ts:412-414 — share of the largest single symbol's P&L among symbols
 * with POSITIVE total P&L (losers never dilute the denominator).
 */
export function topSymbolShare(trades: readonly SimTrade[]): number {
  const pnlBySymbol = new Map<string, number>();
  for (const t of trades) pnlBySymbol.set(t.symbol, (pnlBySymbol.get(t.symbol) ?? 0) + t.netPnlUsd);
  const positive = [...pnlBySymbol.values()].filter((v) => v > 0);
  const total = positive.reduce((a, b) => a + b, 0);
  return total > 0 ? Math.max(...positive) / total : 0;
}

/** Largest peak-to-trough of cumulative R, in exit-time order (§5.10a "Drawdown"). */
export function maxDrawdownR(trades: readonly SimTrade[]): number {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const t of sorted) {
    cumulative += t.rMultiple;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > worst) worst = drawdown;
  }
  return worst;
}
