// Offline trainer for the scalping model (src/strategy/model.ts).
//
// Method: triple-barrier labelling + logistic regression.
//   For each candle i, simulate a long entry at its close and walk FORWARD
//   through the next `horizon` candles asking which barrier is touched
//   first — take-profit (label 1) or stop-loss (label 0). Never touched by
//   the horizon's end counts as 0: a trade that goes nowhere still pays the
//   round-trip fee, so "didn't lose" is not "won".
//
// Correctness properties this script is careful about, because getting any
// of them wrong produces a model that looks excellent and is worthless:
//   - Features at bar i use only candles <= i (enforced in features.ts).
//   - Train/test split is CHRONOLOGICAL, never shuffled — shuffling a time
//     series lets the model learn from its own future.
//   - Standardisation stats come from the TRAIN slice only, then are applied
//     to test; computing them over everything leaks test distribution.
//   - Same-bar ambiguity (a candle whose high hits TP and low hits SL) is
//     resolved pessimistically as a loss, since OHLC can't say which came
//     first and the optimistic reading inflates results.
//   - Test base rate is reported alongside accuracy, because 60% accuracy
//     on a 60%-positive set is exactly zero skill.
//
// Usage:
//   node --experimental-strip-types scripts/train-model.ts \
//     --data data/klines --tp 0.5 --sl 0.4 --horizon 12

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { extractFeatures, FEATURE_NAMES } from "../src/strategy/features.ts";
import type { ModelWeights } from "../src/strategy/model.ts";
import type { Candle } from "../src/strategy/backtest.ts";

interface Args {
  dataDir: string; out: string;
  tp: number; sl: number; horizon: number;
  epochs: number; lr: number; l2: number; testFraction: number;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
  return {
    dataDir: get("--data", "data/klines"),
    out: get("--out", "data/model/scalping-model.json"),
    tp: Number.parseFloat(get("--tp", "0.5")),
    sl: Number.parseFloat(get("--sl", "0.4")),
    horizon: Number.parseInt(get("--horizon", "12"), 10),
    epochs: Number.parseInt(get("--epochs", "400"), 10),
    lr: Number.parseFloat(get("--lr", "0.1")),
    l2: Number.parseFloat(get("--l2", "0.001")),
    testFraction: Number.parseFloat(get("--test-fraction", "0.25")),
  };
}

interface Sample { x: number[]; y: number; t: number; symbol: string }

/**
 * Which barrier does a long entered at `candles[i].close` hit first?
 * Returns 1 for take-profit, 0 for stop-loss or horizon timeout, or null
 * when there aren't enough forward candles to decide (those samples are
 * dropped rather than guessed).
 */
function labelTripleBarrier(candles: Candle[], i: number, tpPct: number, slPct: number, horizon: number): number | null {
  const entry = candles[i]!.close;
  if (!(entry > 0)) return null;
  if (i + horizon >= candles.length) return null;

  const tpPrice = entry * (1 + tpPct / 100);
  const slPrice = entry * (1 - slPct / 100);

  for (let j = i + 1; j <= i + horizon; j++) {
    const c = candles[j]!;
    const hitTp = c.high >= tpPrice;
    const hitSl = c.low <= slPrice;
    // Pessimistic on ambiguity: OHLC alone cannot order two touches inside
    // one candle, and assuming the good one happened first is exactly how
    // backtests get flattering, unreproducible results.
    if (hitSl) return 0;
    if (hitTp) return 1;
  }
  return 0; // horizon expired without reaching TP — still pays the fee
}

function buildSamples(dataDir: string, a: Args): Sample[] {
  const files = readdirSync(dataDir).filter(f => f.endsWith(".json"));
  if (files.length === 0) throw new Error(`No kline files in ${dataDir} — run scripts/fetch-klines.ts first.`);

  const samples: Sample[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(`${dataDir}/${file}`, "utf-8")) as { symbol: string; candles: Candle[] };
    const candles = parsed.candles;
    let kept = 0;
    for (let i = 0; i < candles.length; i++) {
      const y = labelTripleBarrier(candles, i, a.tp, a.sl, a.horizon);
      if (y === null) continue;
      const x = extractFeatures(candles.slice(0, i + 1));
      if (x === null) continue;
      samples.push({ x, y, t: candles[i]!.openTime, symbol: parsed.symbol });
      kept++;
    }
    console.log(`  ${parsed.symbol}: ${kept} usable samples from ${candles.length} candles`);
  }
  return samples;
}

function standardise(train: Sample[]): { mean: number[]; std: number[] } {
  const n = FEATURE_NAMES.length;
  const mean = new Array(n).fill(0);
  const std = new Array(n).fill(0);
  for (const s of train) for (let i = 0; i < n; i++) mean[i] += s.x[i]!;
  for (let i = 0; i < n; i++) mean[i] /= train.length;
  for (const s of train) for (let i = 0; i < n; i++) std[i] += (s.x[i]! - mean[i]) ** 2;
  for (let i = 0; i < n; i++) std[i] = Math.sqrt(std[i] / train.length) || 1;
  return { mean, std };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function train(samples: Sample[], mean: number[], std: number[], a: Args): { weights: number[]; bias: number } {
  const n = FEATURE_NAMES.length;
  const weights = new Array(n).fill(0);
  let bias = 0;
  const z = samples.map(s => s.x.map((v, i) => (v - mean[i]!) / std[i]!));

  for (let epoch = 0; epoch < a.epochs; epoch++) {
    const gradW = new Array(n).fill(0);
    let gradB = 0;
    for (let k = 0; k < samples.length; k++) {
      const xi = z[k]!;
      let dot = bias;
      for (let i = 0; i < n; i++) dot += weights[i]! * xi[i]!;
      const err = sigmoid(dot) - samples[k]!.y;
      for (let i = 0; i < n; i++) gradW[i] += err * xi[i]!;
      gradB += err;
    }
    for (let i = 0; i < n; i++) {
      weights[i] -= a.lr * (gradW[i] / samples.length + a.l2 * weights[i]!);
    }
    bias -= a.lr * (gradB / samples.length);
  }
  return { weights, bias };
}

function evaluate(samples: Sample[], mean: number[], std: number[], weights: number[], bias: number) {
  const scored = samples.map(s => {
    let dot = bias;
    for (let i = 0; i < weights.length; i++) dot += weights[i]! * ((s.x[i]! - mean[i]!) / std[i]!);
    return { p: sigmoid(dot), y: s.y };
  });

  const accuracy = scored.filter(s => (s.p >= 0.5 ? 1 : 0) === s.y).length / scored.length;
  const baseRate = scored.filter(s => s.y === 1).length / scored.length;

  // Rank-based AUC (Mann-Whitney U). 0.5 = coin flip.
  const sorted = [...scored].sort((x, y) => x.p - y.p);
  const pos = sorted.filter(s => s.y === 1).length;
  const neg = sorted.length - pos;
  let rankSum = 0;
  sorted.forEach((s, idx) => { if (s.y === 1) rankSum += idx + 1; });
  const auc = pos === 0 || neg === 0 ? 0.5 : (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);

  return { accuracy, baseRate, auc, scored };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  console.log(`Training scalping model: TP=${a.tp}% SL=${a.sl}% horizon=${a.horizon} bars\n`);

  const samples = buildSamples(a.dataDir, a);
  if (samples.length < 1000) throw new Error(`Only ${samples.length} samples — too few to train anything trustworthy.`);

  // Chronological split. Sorting by time across symbols means the test slice
  // is genuinely "the future" relative to training for every symbol.
  samples.sort((x, y) => x.t - y.t);
  const cut = Math.floor(samples.length * (1 - a.testFraction));
  const trainSet = samples.slice(0, cut);
  const testSet = samples.slice(cut);

  console.log(`\n  total=${samples.length}  train=${trainSet.length}  test=${testSet.length} (chronological split)`);
  console.log(`  train window: ${new Date(trainSet[0]!.t).toISOString().slice(0, 10)} -> ${new Date(trainSet[trainSet.length - 1]!.t).toISOString().slice(0, 10)}`);
  console.log(`  test  window: ${new Date(testSet[0]!.t).toISOString().slice(0, 10)} -> ${new Date(testSet[testSet.length - 1]!.t).toISOString().slice(0, 10)}\n`);

  const { mean, std } = standardise(trainSet);
  const { weights, bias } = train(trainSet, mean, std, a);

  const trainEval = evaluate(trainSet, mean, std, weights, bias);
  const testEval = evaluate(testSet, mean, std, weights, bias);

  console.log(`  train accuracy : ${(trainEval.accuracy * 100).toFixed(2)}%  (base rate ${(trainEval.baseRate * 100).toFixed(2)}%)`);
  console.log(`  TEST  accuracy : ${(testEval.accuracy * 100).toFixed(2)}%  (base rate ${(testEval.baseRate * 100).toFixed(2)}%)`);
  console.log(`  TEST  AUC      : ${testEval.auc.toFixed(4)}   <- 0.50 means no skill\n`);

  console.log("  feature weights (standardised, larger |w| = more influence):");
  FEATURE_NAMES.map((name, i) => ({ name, w: weights[i]! }))
    .sort((x, y) => Math.abs(y.w) - Math.abs(x.w))
    .forEach(({ name, w }) => console.log(`    ${name.padEnd(12)} ${w >= 0 ? " " : ""}${w.toFixed(4)}`));

  const model: ModelWeights = {
    version: 1,
    featureNames: [...FEATURE_NAMES],
    weights, bias, mean, std,
    trainedOn: {
      symbols: [...new Set(samples.map(s => s.symbol))],
      interval: "5",
      candles: samples.length,
      takeProfitPercent: a.tp,
      stopLossPercent: a.sl,
      horizonBars: a.horizon,
    },
    metrics: {
      trainAccuracy: trainEval.accuracy,
      testAccuracy: testEval.accuracy,
      testAuc: testEval.auc,
      testBaseRate: testEval.baseRate,
      testSamples: testSet.length,
    },
  };

  mkdirSync(a.out.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(a.out, JSON.stringify(model, null, 2));
  console.log(`\n  wrote ${a.out}`);

  if (testEval.auc < 0.55) {
    console.log(`\n  ⚠️  TEST AUC ${testEval.auc.toFixed(4)} is close to 0.50 — this model has little or no`);
    console.log(`      real predictive edge on held-out data. Shipping it into the trading`);
    console.log(`      loop would add complexity without adding skill. Treat this as a`);
    console.log(`      measurement, not a failure: it is the honest answer for these`);
    console.log(`      features/labels, and it is exactly what the harness exists to tell you.`);
  }
}

await main();
