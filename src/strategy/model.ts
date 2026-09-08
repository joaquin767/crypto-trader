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

/**
 * Score a candle window directly. Returns null when there isn't enough
 * history to build a feature vector — callers must treat null as "no
 * opinion" and fall back to their own logic, not as a zero probability.
 */
export function scoreCandles(model: ModelWeights, candles: Candle[]): number | null {
  const features = extractFeatures(candles);
  return features === null ? null : scoreFeatures(model, features);
}

export { MIN_CANDLES };
