// Model training — extracted from scripts/train-model.ts so it can be reused.
//
// Why this module exists: scripts/train-model.ts exported nothing and ended in
// a top-level `await main()`, so importing it ran a full training job as a side
// effect. The walk-forward harness (walkforward.ts) has to retrain ~45 times on
// different windows, which is impossible against a CLI. Everything here is pure:
// no file I/O, no clock reads, no module-level mutable state, and no randomness
// — the same samples and params always produce bit-identical weights, which is
// what makes the harness's determinism criterion (spec G0.5) checkable.
//
// The functions are deliberately faithful to the originals; scripts/train-model.ts
// is now a thin CLI over them and still writes the same model file.

import { extractFeatures, FEATURE_NAMES, MIN_CANDLES } from "./features.ts";
import type { Candle } from "./backtest.ts";

export interface Sample { x: number[]; y: number; t: number; symbol: string }

export interface TrainParams {
  tp: number; sl: number; horizon: number;
  epochs: number; lr: number; l2: number;
  /** Time bars per dollar bar; 0 keeps plain time bars. Same units and meaning
   *  as scalping-model.json trainedOn.timeBarsPerDollarBar. Bar conversion is
   *  the CALLER's job — buildSamples takes whatever bars it is given. */
  dollarBars: number;
  /**
   * How many trailing bars to hand extractFeatures for each sample.
   *
   * 0 (the default) reproduces the original behaviour exactly: the whole
   * prefix candles[0..i]. That is O(n^2) in both allocation and work — fine
   * for the 2.5k dollar bars a 60-day file produces, ruinous for the 15k a
   * 365-day file produces, and the harness trains ~45 times.
   *
   * A bounded window is safe because no feature looks back further than ~30
   * bars: the longest are EMA(26), SMA(20), Bollinger(20) and ATR(14). An EMA
   * converges exponentially, so at 200 bars the difference from an unbounded
   * prefix is far below float noise. It is also CLOSER to production, where
   * scoreCandles() is handed a bounded window (~1000 time bars), not the whole
   * history — so the bounded path reduces train/serve skew rather than adding it.
   */
  featureWindow: number;
}

export interface FitResult { weights: number[]; bias: number; mean: number[]; std: number[] }
export interface EvalResult { accuracy: number; auc: number; baseRate: number; n: number }

export const DEFAULT_FEATURE_WINDOW = 200;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Which barrier does a long entered at `candles[i].close` hit first?
 * Returns 1 for take-profit, 0 for stop-loss or horizon timeout, or null when
 * there aren't enough forward candles to decide (dropped rather than guessed).
 *
 * Pessimistic on ambiguity: OHLC alone cannot order two touches inside one
 * candle, and assuming the good one happened first is exactly how backtests get
 * flattering, unreproducible results.
 */
export function labelTripleBarrier(
  candles: Candle[], i: number, tpPct: number, slPct: number, horizon: number,
): number | null {
  const entry = candles[i]!.close;
  if (!(entry > 0)) return null;
  if (i + horizon >= candles.length) return null;

  const tpPrice = entry * (1 + tpPct / 100);
  const slPrice = entry * (1 - slPct / 100);

  for (let j = i + 1; j <= i + horizon; j++) {
    const c = candles[j]!;
    if (c.low <= slPrice) return 0;
    if (c.high >= tpPrice) return 1;
  }
  return 0; // horizon expired without reaching TP — still pays the fee
}

/**
 * Build labelled samples from bars ALREADY restricted to the intended window
 * and ALREADY converted to whatever bar type the caller wants (time or dollar).
 *
 * Pure: performs no I/O and reads no clock. This is the property the harness
 * depends on — it must be able to build samples for one fold's training window
 * without touching the filesystem or seeing any bar outside that window.
 */
export function buildSamples(bySymbol: Record<string, Candle[]>, p: TrainParams): Sample[] {
  const samples: Sample[] = [];
  const window = p.featureWindow > 0 ? p.featureWindow : 0;

  for (const [symbol, candles] of Object.entries(bySymbol)) {
    for (let i = 0; i < candles.length; i++) {
      const y = labelTripleBarrier(candles, i, p.tp, p.sl, p.horizon);
      if (y === null) continue;
      // Bounded slice when featureWindow > 0; the full prefix otherwise.
      const start = window > 0 ? Math.max(0, i + 1 - window) : 0;
      if (i + 1 - start < MIN_CANDLES) continue;
      const x = extractFeatures(candles.slice(start, i + 1));
      if (x === null) continue;
      samples.push({ x, y, t: candles[i]!.openTime, symbol });
    }
  }
  return samples;
}

/** Standardisation constants from the TRAINING set only — never recomputed at
 *  inference, and never computed over a set that includes test data. */
export function standardise(train: Sample[]): { mean: number[]; std: number[] } {
  const n = FEATURE_NAMES.length;
  const mean = new Array(n).fill(0);
  const std = new Array(n).fill(0);
  if (train.length === 0) return { mean, std: std.map(() => 1) };
  for (const s of train) for (let i = 0; i < n; i++) mean[i] += s.x[i]!;
  for (let i = 0; i < n; i++) mean[i] /= train.length;
  for (const s of train) for (let i = 0; i < n; i++) std[i] += (s.x[i]! - mean[i]) ** 2;
  for (let i = 0; i < n; i++) std[i] = Math.sqrt(std[i] / train.length) || 1;
  return { mean, std };
}

/**
 * Fit logistic regression by full-batch gradient descent.
 *
 * Deterministic by construction: weights start at zero, samples are consumed in
 * the order given, and there is no shuffling or RNG anywhere. Same input ⇒
 * bit-identical output, every time.
 */
export function fit(train: Sample[], p: TrainParams): FitResult {
  const { mean, std } = standardise(train);
  const n = FEATURE_NAMES.length;
  const weights = new Array(n).fill(0);
  let bias = 0;
  if (train.length === 0) return { weights, bias, mean, std };

  // Standardise once up front rather than inside the epoch loop.
  const z = train.map(s => s.x.map((v, i) => (v - mean[i]!) / std[i]!));

  for (let epoch = 0; epoch < p.epochs; epoch++) {
    const gradW = new Array(n).fill(0);
    let gradB = 0;
    for (let k = 0; k < train.length; k++) {
      const xi = z[k]!;
      let dot = bias;
      for (let i = 0; i < n; i++) dot += weights[i]! * xi[i]!;
      const err = sigmoid(dot) - train[k]!.y;
      for (let i = 0; i < n; i++) gradW[i] += err * xi[i]!;
      gradB += err;
    }
    for (let i = 0; i < n; i++) weights[i] -= p.lr * (gradW[i] / train.length + p.l2 * weights[i]!);
    bias -= p.lr * (gradB / train.length);
  }
  return { weights, bias, mean, std };
}

/** Accuracy, base rate, and rank-based AUC (Mann-Whitney U). 0.5 AUC = no skill. */
export function evaluate(samples: Sample[], f: FitResult): EvalResult {
  if (samples.length === 0) return { accuracy: 0, auc: 0.5, baseRate: 0, n: 0 };

  const scored = samples.map(s => {
    let dot = f.bias;
    for (let i = 0; i < f.weights.length; i++) dot += f.weights[i]! * ((s.x[i]! - f.mean[i]!) / f.std[i]!);
    return { p: sigmoid(dot), y: s.y };
  });

  const accuracy = scored.filter(s => (s.p >= 0.5 ? 1 : 0) === s.y).length / scored.length;
  const baseRate = scored.filter(s => s.y === 1).length / scored.length;

  const sorted = [...scored].sort((x, y) => x.p - y.p);
  const pos = sorted.filter(s => s.y === 1).length;
  const neg = sorted.length - pos;
  let rankSum = 0;
  sorted.forEach((s, idx) => { if (s.y === 1) rankSum += idx + 1; });
  const auc = pos === 0 || neg === 0 ? 0.5 : (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);

  return { accuracy, auc, baseRate, n: samples.length };
}

/** Median gap between consecutive bars — the honest "how long is a bar?" for
 *  dollar bars, which have no fixed interval. */
export function medianBarMs(times: number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}
