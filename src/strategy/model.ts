// Scalping model — inference side.
//
// A logistic-regression classifier trained offline (scripts/train-model.ts)
// on real Bybit klines, answering one narrow question per candle: given this
// feature vector, what's the probability that a long entry here reaches its
// take-profit barrier before its stop-loss barrier, within the horizon it
// was trained for?
//
// Deliberately a linear model, not something bigger: with ~86k samples and
// 16 features, a linear model is what the data can actually support without
// overfitting, its weights are inspectable (you can read why it decided
// something), and inference is a dot product — microseconds, no network, no
// API cost, nothing to time out in the trading loop. If and when the
// backtest shows a linear model leaves signal on the table, that's the
// evidence to justify something heavier.
//
// It is NOT a profit oracle. It shifts the entry decision from unvalidated
// hand-picked thresholds to something measured against held-out data, and
// runBacktest() remains the arbiter of whether it actually helps.

import { readFileSync, existsSync } from "node:fs";
import { extractFeatures, FEATURE_NAMES, MIN_CANDLES } from "./features.ts";
import { toDollarBars, suggestDollarThreshold } from "./bars.ts";
import type { Candle } from "./backtest.ts";

export interface ModelWeights {
  /** Schema/version marker so a stale weights file can't be loaded silently. */
  version: 1;
  /** Must match FEATURE_NAMES exactly, in order — guards train/serve skew. */
  featureNames: string[];
  weights: number[];
  bias: number;
  /** Per-feature standardisation from the TRAINING set (never recomputed
   *  at inference — that would leak live distribution into the model). */
  mean: number[];
  std: number[];
  /** What the model was trained to predict, recorded for auditability. */
  trainedOn: {
    symbols: string[];
    interval: string;
    candles: number;
    takeProfitPercent: number;
    stopLossPercent: number;
    horizonBars: number;
    /** How many TIME bars, on average, went into one training dollar bar.
     *  0 means the model was trained on plain time bars.
     *
     *  Stored as a ratio rather than an absolute dollar threshold on
     *  purpose: dollar volume differs enormously between symbols (SOL's
     *  threshold was 49x APT's), so a single stored figure fits whichever
     *  symbol happened to be processed last and starves all the others —
     *  it produced 1 dollar bar instead of 30, silently disabling the
     *  model. Each symbol now derives its own threshold to hit this same
     *  compression, exactly as training did per symbol. */
    timeBarsPerDollarBar?: number;
    /** Median wall-clock duration of one training bar, in ms. Dollar bars
     *  have no fixed interval, so the horizon exit needs this to convert
     *  "N bars" into a real elapsed time. */
    avgBarMs?: number;
  };
  /** Held-out performance — the honest read on whether it learned anything. */
  metrics: {
    trainAccuracy: number;
    testAccuracy: number;
    testAuc: number;
    testBaseRate: number;
    testSamples: number;
  };
}

export const DEFAULT_MODEL_PATH = "data/model/scalping-model.json";

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Load and validate a weights file. Returns null (never throws, never a
 * partially-valid model) if it's missing or doesn't match the feature
 * contract this build expects — callers then simply run without the model
 * rather than scoring against garbage.
 */
export function loadModel(path: string = DEFAULT_MODEL_PATH): ModelWeights | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelWeights;
    const okShape =
      parsed.version === 1 &&
      Array.isArray(parsed.weights) &&
      Array.isArray(parsed.featureNames) &&
      parsed.weights.length === FEATURE_NAMES.length &&
      parsed.mean?.length === FEATURE_NAMES.length &&
      parsed.std?.length === FEATURE_NAMES.length &&
      parsed.featureNames.length === FEATURE_NAMES.length &&
      parsed.featureNames.every((n, i) => n === FEATURE_NAMES[i]);
    if (!okShape) {
      console.warn(`[model] Ignoring ${path}: feature contract doesn't match this build (expected ${FEATURE_NAMES.length} features in the order defined by features.ts). Retrain with scripts/train-model.ts.`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`[model] Ignoring ${path}: ${(err as Error).message}`);
    return null;
  }
}

/** Score a pre-computed feature vector. Returns a probability in [0, 1]. */
export function scoreFeatures(model: ModelWeights, features: number[]): number {
  let z = model.bias;
  for (let i = 0; i < features.length; i++) {
    const std = model.std[i] || 1;
    z += model.weights[i]! * ((features[i]! - model.mean[i]!) / std);
  }
  return sigmoid(z);
}

/** Time bars used to calibrate a symbol's dollar threshold. Fixed on
 *  purpose — see resolveDollarThreshold. Sized so that a 1000-bar backfill
 *  leaves ~600 further positions to sample a score DISTRIBUTION from (see
 *  scoreQuantile); 400 time bars is still ~59 dollar bars, comfortably
 *  above MIN_CANDLES. */
const THRESHOLD_REFERENCE_BARS = 400;

/** Per-symbol dollar threshold, calibrated once. */
const thresholdCache = new Map<string, number>();

/** Drop cached thresholds (tests, or a symbol set change). */
export function resetThresholdCache(): void {
  thresholdCache.clear();
}

/**
 * The dollar threshold for a symbol — calibrated ONCE from a fixed-length
 * reference window and then reused.
 *
 * This was previously derived from whatever window the caller happened to
 * pass, which made the score depend on how much history was supplied: the
 * same bar scored 0.598 with 300 candles of context and 0.441 with 1000,
 * because a different threshold produced different bar boundaries and
 * therefore different features. The backtest passed 1000-bar windows while
 * other callers passed shorter ones, so a threshold tuned on the backtest
 * did not transfer to live at all.
 *
 * Fixing the reference length makes a given bar score the same regardless
 * of how it is queried.
 */
function resolveDollarThreshold(symbol: string, candles: Candle[], ratio: number): number | null {
  const cached = thresholdCache.get(symbol);
  if (cached !== undefined) return cached;

  // Wait for a full reference window before committing, so the calibration
  // isn't taken from an unrepresentative sliver of history.
  if (candles.length < THRESHOLD_REFERENCE_BARS) return null;

  const reference = candles.slice(-THRESHOLD_REFERENCE_BARS);
  const threshold = suggestDollarThreshold(reference, Math.floor(reference.length / ratio));
  if (!(threshold > 0)) return null;
  thresholdCache.set(symbol, threshold);
  return threshold;
}

/**
 * Score a candle window directly. Returns null when there isn't enough
 * history to build a feature vector — callers must treat null as "no
 * opinion" and fall back to their own logic, not as a zero probability.
 *
 * `symbol` keys the per-symbol dollar-threshold calibration; a model
 * trained on plain time bars ignores it.
 */
export function scoreCandles(model: ModelWeights, candles: Candle[], symbol = "default"): number | null {
  // Rebuild bars the way this model was TRAINED, not the way the live loop
  // happens to store them. A model fit on dollar bars scored against 5m
  // time bars is exactly the train/serve skew that makes these models fail
  // silently — the features would be computed over a different sampling of
  // the same market and the probabilities would be confident nonsense.
  const ratio = model.trainedOn.timeBarsPerDollarBar ?? 0;
  let bars = candles;
  if (ratio > 1) {
    const threshold = resolveDollarThreshold(symbol, candles, ratio);
    if (threshold === null) return null;   // not enough history to calibrate yet
    bars = toDollarBars(candles, threshold);
  }
  const features = extractFeatures(bars);
  return features === null ? null : scoreFeatures(model, features);
}

/**
 * The distribution of scores this model produces for `symbol` over its own
 * recent history — used to set an entry threshold as a PERCENTILE rather
 * than an absolute probability.
 *
 * Absolute thresholds do not transfer: this model was fit on a ~26%
 * positive base rate, so its outputs cluster near 0.26, and the ceiling
 * differs per symbol (APT topped out at 0.468, SOL at 0.284). A "p >= 0.55"
 * rule tuned on one window silently means "never trade" on another.
 */
export function scoreQuantile(
  model: ModelWeights, candles: Candle[], symbol: string, percentile: number, samples = 200,
): number | null {
  if (candles.length < THRESHOLD_REFERENCE_BARS) return null;
  const scores: number[] = [];
  const step = Math.max(1, Math.floor((candles.length - THRESHOLD_REFERENCE_BARS) / samples));
  for (let end = THRESHOLD_REFERENCE_BARS; end <= candles.length; end += step) {
    const p = scoreCandles(model, candles.slice(0, end), symbol);
    if (p !== null) scores.push(p);
  }
  if (scores.length < 20) return null;
  scores.sort((a, b) => a - b);
  const idx = Math.min(scores.length - 1, Math.floor(scores.length * (1 - percentile / 100)));
  return scores[idx]!;
}

export { MIN_CANDLES };
