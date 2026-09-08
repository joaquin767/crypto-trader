// Cross-check export — half one of an independent validation of our execution
// and accounting layer against freqtrade.
//
// WHY THIS SHAPE. The obvious cross-check — reimplement the strategy in
// freqtrade and compare — is a trap: our entry rule is a rule-based score
// (RSI/MACD/Bollinger/momentum/volume/SMA) AND a cost gate AND a 21-feature
// logistic model AND an N-tick confirmation streak. Reimplementing all of that
// in pandas would introduce more divergence risk than the exercise removes,
// and a mismatch would tell us nothing about which side was wrong.
//
// So instead this exports the DECISIONS our engine makes — the exact bar
// timestamps it chose to enter on — and the freqtrade strategy replays them.
// Freqtrade then applies its own execution: fill prices, stop-loss, ROI exit,
// time-based exit, fee accounting, P&L, drawdown.
//
// WHAT THAT VALIDATES: entry fill timing/price, barrier trigger logic, the
// horizon/time exit, fee accounting on both legs, P&L arithmetic. That is
// precisely where all eight of this project's measurement artifacts lived
// (specs/profit-target-roadmap.md §2.5), including the executor Date.now() bug
// that silently disabled the horizon exit in every backtest ever run.
//
// WHAT IT DOES NOT VALIDATE: the signal logic itself, which is shared rather
// than reimplemented. That is covered separately by tests/walkforward.test.ts's
// no-lookahead assertion. Stating the boundary is the point — a cross-check
// whose scope is vague is worth very little.
//
// Usage:
//   node --experimental-strip-types scripts/crosscheck-export.ts \
//     --data data/klines-365 --symbols APTUSDT,ARBUSDT,LINKUSDT,OPUSDT,SOLUSDT \
//     --train-start 2025-09-10 --train-days 90 --test-days 90

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { runBacktest } from "../src/strategy/backtest.ts";
import { buildSamples, fit, DEFAULT_FEATURE_WINDOW } from "../src/strategy/training.ts";
import type { TrainParams } from "../src/strategy/training.ts";
import { FEATURE_NAMES } from "../src/strategy/features.ts";
import { DAY_MS } from "../src/strategy/walkforward.ts";
import type { Candle } from "../src/strategy/backtest.ts";
import type { ModelWeights } from "../src/strategy/model.ts";
import type { Config } from "../src/config.ts";

function get(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}

const OUT_DIR = "data/validation/crosscheck";

function readCandles(dataDir: string, symbol: string): Candle[] {
  const parsed = JSON.parse(
    readFileSync(`${dataDir}/${symbol}-5m.json`, "utf-8"),
  ) as { candles: Candle[] };
  return parsed.candles;
}

const slice = (c: Candle[], from: number, to: number) =>
  c.filter(x => x.openTime >= from && x.openTime < to);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dataDir = get(argv, "--data", "data/klines-365");
  const symbols = get(argv, "--symbols", "").split(",").map(s => s.trim()).filter(Boolean);
  if (symbols.length === 0) throw new Error("--symbols is required");

  const trainStart = Date.parse(`${get(argv, "--train-start", "2025-09-10")}T00:00:00Z`);
  const trainDays = Number.parseInt(get(argv, "--train-days", "90"), 10);
  const testDays = Number.parseInt(get(argv, "--test-days", "90"), 10);
  const trainEnd = trainStart + trainDays * DAY_MS;
  const testEnd = trainEnd + testDays * DAY_MS;

  // Horizon on 5m TIME bars. The deployed model uses 7 dollar bars at a
  // measured 35.0 min/bar = 4h05m; 48 five-minute bars is 4h00m, the closest
  // time-bar equivalent. freqtrade is time-bar native, so the cross-check has
  // to happen on time bars — which is why this is 48 and not 7.
  const horizon = Number.parseInt(get(argv, "--horizon", "48"), 10);
  const tp = Number.parseFloat(get(argv, "--tp", "1.5"));
  const sl = Number.parseFloat(get(argv, "--sl", "1.5"));

  const base = loadConfig(get(argv, "--config", "./config.json"));

  // Cross-check config: deliberately simplified on BOTH sides so that any
  // disagreement points at the execution layer rather than at a modelling
  // difference neither engine claims to share.
  //   - post-only entries OFF: freqtrade does not simulate a resting bid the
  //     way runBacktest does, and that fill model would dominate the diff.
  //   - maker fee == taker fee: one rate per side, matching freqtrade's
  //     single `fee` setting exactly.
  //   - percentile gate OFF, absolute probability ON: a percentile threshold
  //     recalibrates from whatever window it is handed, which is not portable.
  const config: Config = {
    ...base,
    usePostOnlyEntries: false,
    simulatedMakerFeePercent: 0.055,
    simulatedTakerFeePercent: 0.055,
    takeProfitPercent: tp,
    stopLossPercent: sl,
    modelTopPercentile: undefined,
    modelMinProbability: Number.parseFloat(get(argv, "--min-prob", "0.5")),
    signalConfirmationTicks: 1,
  };

  console.log("Cross-check export (half 1 of 2 — freqtrade replays these decisions)");
  console.log(`  train  ${new Date(trainStart).toISOString().slice(0, 10)} -> ${new Date(trainEnd).toISOString().slice(0, 10)} (${trainDays}d)`);
  console.log(`  test   ${new Date(trainEnd).toISOString().slice(0, 10)} -> ${new Date(testEnd).toISOString().slice(0, 10)} (${testDays}d)`);
  console.log(`  bars   5m time bars, horizon ${horizon} bars (${(horizon * 5 / 60).toFixed(1)}h)`);
  console.log(`  cost   ${config.simulatedTakerFeePercent}% per side, both legs taker`);
  console.log(`  gate   p >= ${config.modelMinProbability}\n`);

  // ── train one model on the training window ────────────────────────────
  const params: TrainParams = {
    tp, sl, horizon, epochs: 200, lr: 0.1, l2: 0.001,
    dollarBars: 0, featureWindow: DEFAULT_FEATURE_WINDOW,
  };

  const trainBars: Record<string, Candle[]> = {};
  const allCandles: Record<string, Candle[]> = {};
  for (const s of symbols) {
    const c = readCandles(dataDir, s);
    allCandles[s] = c;
    trainBars[s] = slice(c, trainStart, trainEnd);
  }
  const samples = buildSamples(trainBars, params).sort((a, b) => a.t - b.t);
  if (samples.length < 1000) throw new Error(`only ${samples.length} training samples`);
  const fitted = fit(samples, params);
  console.log(`  trained on ${samples.length} samples\n`);

  const model: ModelWeights = {
    version: 1,
    featureNames: [...FEATURE_NAMES],
    weights: fitted.weights, bias: fitted.bias, mean: fitted.mean, std: fitted.std,
    trainedOn: {
      symbols: [...symbols], interval: "5",
      candles: Object.values(trainBars).reduce((a, b) => a + b.length, 0),
      takeProfitPercent: tp, stopLossPercent: sl, horizonBars: horizon,
      timeBarsPerDollarBar: 0, avgBarMs: 5 * 60_000,
    },
    metrics: { trainAccuracy: 0, testAccuracy: 0, testAuc: 0, testBaseRate: 0, testSamples: 0 },
  };

  // ── run OUR engine on the test window, capturing its decisions ─────────
  mkdirSync(OUT_DIR, { recursive: true });
  const ourTrades: Record<string, unknown[]> = {};
  const entrySignals: Record<string, number[]> = {};
  let totalPnl = 0, totalTrades = 0;

  for (const s of symbols) {
    const window = slice(allCandles[s]!, trainEnd, testEnd);
    const report = await runBacktest(window, s, config, model);

    // Entry timestamps are what freqtrade replays. Exits are recorded so the
    // two engines' exit decisions can be diffed too, but freqtrade decides
    // its own exits from its stoploss/ROI/custom_exit rules — that is the
    // whole point of the comparison.
    entrySignals[s] = report.trades.map(t => t.entryTime);
    ourTrades[s] = report.trades;
    totalPnl += report.totalPnl;
    totalTrades += report.closedTrades;

    console.log(`  ${s.padEnd(10)} ${String(report.closedTrades).padStart(3)} trades  ` +
      `net ${report.totalPnl >= 0 ? "+" : ""}$${report.totalPnl.toFixed(3)}  ` +
      `fees $${report.totalFees.toFixed(3)}`);
  }

  console.log(`\n  OUR ENGINE: ${totalTrades} trades, net ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(3)} on $${config.maxCapitalUsd}`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    kind: "crosscheck-export",
    note: "Entry timestamps are replayed by the freqtrade strategy; freqtrade applies its own execution, fees and P&L. See scripts/crosscheck-export.ts header for what this does and does not validate.",
    window: {
      trainStart, trainEnd, testEnd,
      trainStartIso: new Date(trainStart).toISOString(),
      testStartIso: new Date(trainEnd).toISOString(),
      testEndIso: new Date(testEnd).toISOString(),
    },
    strategy: {
      takeProfitPercent: tp, stopLossPercent: sl, horizonBars: horizon,
      horizonMinutes: horizon * 5,
      feePercentPerSide: config.simulatedTakerFeePercent,
      modelMinProbability: config.modelMinProbability,
      maxCapitalUsd: config.maxCapitalUsd,
      maxPositionSizeUsd: config.maxPositionSizeUsd,
    },
    ourResult: { closedTrades: totalTrades, totalPnl },
    entrySignals,
    ourTrades,
  };

  writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`\n  wrote ${OUT_DIR}/manifest.json`);
  console.log(`  entry signals: ${Object.entries(entrySignals).map(([s, v]) => `${s}=${v.length}`).join(" ")}`);
}

await main();
