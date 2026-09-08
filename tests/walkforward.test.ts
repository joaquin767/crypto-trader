// Walk-forward harness tests — specs/profit-target-roadmap.md G0.5.
//
// The important one here is `no-lookahead`. Everything else in the gate is
// bookkeeping; a leak of test-window data into training would make every
// number the gate produces optimistic in a way that is completely invisible
// in the output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildFolds, DAY_MS, WalkForwardError, median, percentile, binomialUpperTail, runWalkForward,
} from "../src/strategy/walkforward.ts";
import { buildSamples, fit, standardise, DEFAULT_FEATURE_WINDOW } from "../src/strategy/training.ts";
import type { TrainParams } from "../src/strategy/training.ts";
import type { Candle } from "../src/strategy/backtest.ts";

const PARAMS: TrainParams = {
  tp: 1.5, sl: 1.5, horizon: 7,
  epochs: 20, lr: 0.1, l2: 0.001,
  dollarBars: 0, featureWindow: DEFAULT_FEATURE_WINDOW,
};

/** Deterministic pseudo-random candles — a fixed LCG, so every run sees the
 *  same series and a failure is reproducible. */
function synthCandles(n: number, startMs: number, stepMs = 5 * 60_000): Candle[] {
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * 0.6;
    const open = price;
    price = Math.max(1, price * (1 + drift / 100));
    const high = Math.max(open, price) * (1 + rand() * 0.002);
    const low = Math.min(open, price) * (1 - rand() * 0.002);
    out.push({ openTime: startMs + i * stepMs, open, high, low, close: price, volume: 1000 + rand() * 5000 });
  }
  return out;
}

// ── buildFolds ────────────────────────────────────────────────────────────

test("buildFolds: folds are contiguous, test follows train, step is in days", () => {
  const first = Date.UTC(2026, 0, 1);
  const last = first + 120 * DAY_MS;
  const folds = buildFolds(first, last, 30, 7, 7);

  assert.ok(folds.length >= 12, `expected >=12 folds, got ${folds.length}`);
  for (const f of folds) {
    assert.equal(f.testStart, f.trainEnd, "test window must start exactly where training ends");
    assert.equal(f.trainEnd - f.trainStart, 30 * DAY_MS);
    assert.equal(f.testEnd - f.testStart, 7 * DAY_MS);
    assert.ok(f.testEnd <= last, "no fold may extend past the data");
  }
  for (let i = 1; i < folds.length; i++) {
    // The units assertion: step is DAYS, bounds are MILLISECONDS.
    assert.equal(folds[i]!.testStart, folds[i - 1]!.testStart + 7 * DAY_MS);
    assert.equal(folds[i]!.index, folds[i - 1]!.index + 1);
  }
});

test("buildFolds: returns [] when less than one full train+test window fits", () => {
  const first = Date.UTC(2026, 0, 1);
  assert.deepEqual(buildFolds(first, first + 30 * DAY_MS, 30, 7, 7), []);
  assert.deepEqual(buildFolds(first, first + 36 * DAY_MS, 30, 7, 7), []);
  // Exactly one window fits at 37 days.
  assert.equal(buildFolds(first, first + 37 * DAY_MS, 30, 7, 7).length, 1);
});

test("buildFolds: never emits a partial or shortened training window", () => {
  const first = Date.UTC(2026, 0, 1);
  const folds = buildFolds(first, first + 100 * DAY_MS, 30, 7, 7);
  for (const f of folds) assert.equal(f.trainEnd - f.trainStart, 30 * DAY_MS);
});

test("buildFolds: rejects non-positive geometry", () => {
  const first = Date.UTC(2026, 0, 1);
  assert.throws(() => buildFolds(first, first + 100 * DAY_MS, 0, 7, 7), WalkForwardError);
  assert.throws(() => buildFolds(first, first + 100 * DAY_MS, 30, 0, 7), WalkForwardError);
  assert.throws(() => buildFolds(first, first + 100 * DAY_MS, 30, 7, 0), WalkForwardError);
});

// ── no look-ahead ─────────────────────────────────────────────────────────

test("no-lookahead: poisoning every candle at or after testStart leaves the fitted model bit-identical", () => {
  const start = Date.UTC(2026, 0, 1);
  const all = synthCandles(3000, start);
  const testStart = all[2000]!.openTime;

  const trainWindow = (candles: Candle[]) => candles.filter(c => c.openTime < testStart);

  // Clean training half.
  const clean = fit(buildSamples({ SYNTH: trainWindow(all) }, PARAMS), PARAMS);

  // Every bar at or after testStart replaced with NaN. If ANY of it reached
  // the training path — through a feature window that runs past the boundary,
  // a standardisation pass over the whole array, a label that peeks forward
  // past trainEnd — the fit would differ (or become NaN).
  const poisoned = all.map(c => c.openTime >= testStart
    ? { ...c, open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN }
    : c);
  const after = fit(buildSamples({ SYNTH: trainWindow(poisoned) }, PARAMS), PARAMS);

  assert.deepEqual(after.weights, clean.weights, "weights changed — test data reached training");
  assert.equal(after.bias, clean.bias);
  assert.deepEqual(after.mean, clean.mean, "standardisation mean changed — test data reached training");
  assert.deepEqual(after.std, clean.std);
  assert.ok(clean.weights.every(Number.isFinite), "clean fit produced non-finite weights");
});

test("no-lookahead: triple-barrier labels never look past the window they are given", () => {
  const start = Date.UTC(2026, 0, 1);
  const all = synthCandles(1200, start);
  const cut = 800;
  const window = all.slice(0, cut);

  // Samples built from the truncated window must be a prefix-compatible subset:
  // the last `horizon` bars cannot be labelled at all, so they are dropped
  // rather than labelled using bars the window does not contain.
  const s = buildSamples({ SYNTH: window }, PARAMS);
  const lastLabelled = Math.max(...s.map(x => x.t));
  const cutoffTime = window[cut - 1 - PARAMS.horizon]!.openTime;
  assert.ok(lastLabelled <= cutoffTime,
    `labelled a bar at ${lastLabelled} that needs data past the window (cutoff ${cutoffTime})`);
});

// ── determinism ───────────────────────────────────────────────────────────

test("fit is deterministic: same samples and params give bit-identical weights", () => {
  const candles = synthCandles(1500, Date.UTC(2026, 0, 1));
  const samples = buildSamples({ SYNTH: candles }, PARAMS);
  assert.ok(samples.length > 100, `expected samples, got ${samples.length}`);

  const a = fit(samples, PARAMS);
  const b = fit(samples, PARAMS);
  assert.deepEqual(a.weights, b.weights);
  assert.equal(a.bias, b.bias);
  assert.deepEqual(a.mean, b.mean);
  assert.deepEqual(a.std, b.std);
});

test("buildSamples is pure: called twice on the same input it returns identical samples", () => {
  const candles = synthCandles(800, Date.UTC(2026, 0, 1));
  const a = buildSamples({ SYNTH: candles }, PARAMS);
  const b = buildSamples({ SYNTH: candles }, PARAMS);
  assert.deepEqual(a, b);
});

test("standardise uses only the samples given to it", () => {
  const candles = synthCandles(900, Date.UTC(2026, 0, 1));
  const samples = buildSamples({ SYNTH: candles }, PARAMS);
  const half = samples.slice(0, Math.floor(samples.length / 2));
  const onHalf = standardise(half);
  const onAll = standardise(samples);
  assert.notDeepEqual(onHalf.mean, onAll.mean,
    "standardising a subset gave the same constants as the full set — suspicious");
});

// ── statistics ────────────────────────────────────────────────────────────

test("median: even-length is the mean of the two central values", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 2, 1, 3]), 2.5);   // order-independent
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([]), 0);
  // The boundary that G0.6 step 2 actually turns on.
  assert.equal(median([-1, 1]), 0);
});

test("percentile: p90 of 1..10", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([], 0.9), 0);
});

test("binomialUpperTail: P(X >= k) is inclusive of k", () => {
  // n=2: P(X>=0)=1, P(X>=1)=0.75, P(X>=2)=0.25
  assert.ok(Math.abs(binomialUpperTail(0, 2) - 1) < 1e-9);
  assert.ok(Math.abs(binomialUpperTail(1, 2) - 0.75) < 1e-9);
  assert.ok(Math.abs(binomialUpperTail(2, 2) - 0.25) < 1e-9);
  // Symmetry: half of n is just over 0.5 because the tail includes k.
  assert.ok(binomialUpperTail(50, 100) > 0.5);
  assert.ok(binomialUpperTail(51, 100) < 0.5);
  assert.equal(binomialUpperTail(101, 100), 0);
  // 45 folds, 29 positive — the shape the gate actually evaluates.
  const p = binomialUpperTail(29, 45);
  assert.ok(p > 0 && p < 0.06, `expected a small but non-zero tail, got ${p}`);
});

// ── failure modes ─────────────────────────────────────────────────────────

test("runWalkForward rejects, naming the symbol, when a kline file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  try {
    await assert.rejects(
      () => runWalkForward({
        dataDir: dir, symbols: ["NOPEUSDT"],
        config: { maxCapitalUsd: 100 } as never,
        trainDays: 30, testDays: 7, stepDays: 7,
        tp: 1.5, sl: 1.5, horizon: 7, timeBarsPerDollarBar: 0,
      }),
      (err: unknown) => {
        assert.ok(err instanceof WalkForwardError);
        assert.match((err as Error).message, /NOPEUSDT/);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runWalkForward rejects, naming the symbol, when a kline file is unparseable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  try {
    writeFileSync(join(dir, "BADUSDT-5m.json"), "{ not json");
    await assert.rejects(
      () => runWalkForward({
        dataDir: dir, symbols: ["BADUSDT"],
        config: { maxCapitalUsd: 100 } as never,
        trainDays: 30, testDays: 7, stepDays: 7,
        tp: 1.5, sl: 1.5, horizon: 7, timeBarsPerDollarBar: 0,
      }),
      (err: unknown) => {
        assert.ok(err instanceof WalkForwardError);
        assert.match((err as Error).message, /BADUSDT/);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runWalkForward returns insufficient_data, not a partial fold, when history is too short", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  try {
    // 10 days of 5m candles — nowhere near a 30+7 day window.
    const candles = synthCandles(10 * 288, Date.UTC(2026, 0, 1));
    writeFileSync(join(dir, "SHORTUSDT-5m.json"),
      JSON.stringify({ symbol: "SHORTUSDT", interval: "5", candles }));

    const report = await runWalkForward({
      dataDir: dir, symbols: ["SHORTUSDT"],
      config: { maxCapitalUsd: 100 } as never,
      trainDays: 30, testDays: 7, stepDays: 7,
      tp: 1.5, sl: 1.5, horizon: 7, timeBarsPerDollarBar: 0,
    });

    assert.equal(report.verdict, "insufficient_data");
    assert.equal(report.totalFolds, 0);
    assert.deepEqual(report.folds, []);
    assert.match(report.verdictReason, /no complete/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
