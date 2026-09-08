// Baseline held-out backtest — the reproducible artifact behind the headline
// expectancy figure quoted in specs/profit-target-roadmap.md §2.1.
//
// Before this script existed, that figure ("+$0.497 on $100, 40 trades") came
// from an ad-hoc run that was never committed, so nobody could check it. That
// is exactly the failure the roadmap spec's own principle P-2 forbids ("a gate
// is cleared by a recorded number, not by a judgment"), so it gets a committed
// script and a committed report.
//
// Runs runBacktest() over the HELD-OUT tail of each symbol's kline file — the
// same fraction scripts/train-model.ts reserves as its test split — so the
// model being evaluated was not fit on the bars it is scored against.
//
// This is a single chronological split, NOT walk-forward validation. It
// inherits every limitation the roadmap spec's F1 describes: one window, one
// regime, no error bars. It exists to make the current number checkable, not
// to make it trustworthy. Gate 0 is what makes it trustworthy.
//
// Usage:
//   node --experimental-strip-types scripts/backtest.ts \
//     --data data/klines --config ./config.json --held-out 0.25

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { runBacktest } from "../src/strategy/backtest.ts";
import { loadModel, DEFAULT_MODEL_PATH } from "../src/strategy/model.ts";
import type { Candle, BacktestReport } from "../src/strategy/backtest.ts";

interface Args { dataDir: string; configPath: string; heldOut: number; out: string }

function parseArgs(argv: string[]): Args {
  const get = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
  return {
    dataDir: get("--data", "data/klines"),
    configPath: get("--config", "./config.json"),
    heldOut: Number.parseFloat(get("--held-out", "0.25")),
    out: get("--out", `data/validation/baseline-backtest-${new Date().toISOString().slice(0, 10)}.json`),
  };
}

/** Kline files are `{ symbol, interval, ..., candles: Candle[] }`. */
function readCandles(path: string): { symbol: string; candles: Candle[] } {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { symbol: string; candles: Candle[] };
  if (!Array.isArray(raw.candles) || raw.candles.length === 0) {
    throw new Error(`${path}: no candles array`);
  }
  return { symbol: raw.symbol, candles: raw.candles };
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!(a.heldOut > 0 && a.heldOut < 1)) throw new Error(`--held-out must be in (0,1), got ${a.heldOut}`);

  const config = loadConfig(a.configPath);
  const model = loadModel(DEFAULT_MODEL_PATH);
  if (!model) throw new Error(`No usable model at ${DEFAULT_MODEL_PATH} — train one first.`);

  const files = readdirSync(a.dataDir).filter(f => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`No kline files in ${a.dataDir}`);

  console.log(`Baseline held-out backtest — last ${pct(a.heldOut)} of each symbol's history`);
  console.log(`  model AUC ${model.metrics.testAuc.toFixed(4)}, capital $${config.maxCapitalUsd}`);
  console.log(`  TP ${config.takeProfitPercent}% / SL ${config.stopLossPercent}%`);
  console.log(`  maker ${config.simulatedMakerFeePercent ?? 0.02}% / taker ${config.simulatedTakerFeePercent ?? 0.055}% per side\n`);

  const reports: BacktestReport[] = [];
  let windowStart = Number.POSITIVE_INFINITY, windowEnd = 0;

  // Sequential, never parallel: runBacktest() clears and owns module-level
  // indicator/candle/threshold state for its duration (see its doc comment),
  // so two concurrent runs in one process would corrupt each other.
  for (const file of files) {
    const { symbol, candles } = readCandles(`${a.dataDir}/${file}`);
    const cut = Math.floor(candles.length * (1 - a.heldOut));
    const heldOut = candles.slice(cut);
    windowStart = Math.min(windowStart, heldOut[0]!.openTime);
    windowEnd = Math.max(windowEnd, heldOut[heldOut.length - 1]!.openTime);

    const report = await runBacktest(heldOut, symbol, config);
    reports.push(report);
    const fillRate = report.restingPlaced ? (report.restingFilled ?? 0) / report.restingPlaced : null;
    console.log(
      `  ${symbol.padEnd(10)} ${String(report.closedTrades).padStart(3)} trades  ` +
      `win ${pct(report.winRate).padStart(7)}  net ${report.totalPnl >= 0 ? "+" : ""}$${report.totalPnl.toFixed(3)}  ` +
      `fees $${report.totalFees.toFixed(3)}  ` +
      `fill ${fillRate === null ? "n/a" : pct(fillRate)}`,
    );
  }

  const closedTrades = reports.reduce((s, r) => s + r.closedTrades, 0);
  const totalPnl = reports.reduce((s, r) => s + r.totalPnl, 0);
  const totalFees = reports.reduce((s, r) => s + r.totalFees, 0);
  const wins = reports.reduce((s, r) => s + r.winRate * r.closedTrades, 0);
  const restingPlaced = reports.reduce((s, r) => s + (r.restingPlaced ?? 0), 0);
  const restingFilled = reports.reduce((s, r) => s + (r.restingFilled ?? 0), 0);
  const days = (windowEnd - windowStart) / 86_400_000;

  // Net return is expressed against a SINGLE maxCapitalUsd even though the
  // symbols were replayed independently. That is the pessimistic reading and
  // the one that matches how the live bot is funded: one capital pool serves
  // every symbol, so the returns share a denominator rather than each getting
  // their own.
  const netReturnPercent = (totalPnl / config.maxCapitalUsd) * 100;
  const dailyReturnPercent = days > 0 ? netReturnPercent / days : 0;

  console.log(`\n  ${"TOTAL".padEnd(10)} ${closedTrades} trades  win ${pct(closedTrades ? wins / closedTrades : 0)}  ` +
              `net ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(3)} on $${config.maxCapitalUsd}`);
  console.log(`  window ${new Date(windowStart).toISOString().slice(0, 10)} -> ${new Date(windowEnd).toISOString().slice(0, 10)} (${days.toFixed(1)} days)`);
  console.log(`  net return ${netReturnPercent.toFixed(4)}%  =  ${dailyReturnPercent.toFixed(4)}% / day`);

  // Report only non-secret config. config.json holds live API credentials and
  // is gitignored (.gitignore:5); this artifact IS committed, so it must never
  // carry apiKey/apiSecret. Fields are enumerated explicitly rather than
  // spread-and-deleted, so a newly added secret field cannot leak by default.
  const artifact = {
    generatedAt: new Date().toISOString(),
    kind: "baseline-held-out-backtest",
    caveat:
      "Single chronological split over one window in one regime. Not walk-forward validated. " +
      "See specs/profit-target-roadmap.md F1 — this number has no error bars and must not be " +
      "used to justify a capital increase.",
    command: `node --experimental-strip-types scripts/backtest.ts --data ${a.dataDir} --config ${a.configPath} --held-out ${a.heldOut}`,
    heldOutFraction: a.heldOut,
    window: {
      startMs: windowStart, endMs: windowEnd,
      start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString(),
      days: Number(days.toFixed(4)),
    },
    model: { path: DEFAULT_MODEL_PATH, trainedOn: model.trainedOn, metrics: model.metrics },
    config: {
      maxCapitalUsd: config.maxCapitalUsd,
      maxPositionSizeUsd: config.maxPositionSizeUsd,
      takeProfitPercent: config.takeProfitPercent,
      stopLossPercent: config.stopLossPercent,
      useModelGate: config.useModelGate ?? false,
      modelMinProbability: config.modelMinProbability ?? null,
      modelTopPercentile: config.modelTopPercentile ?? null,
      usePostOnlyEntries: config.usePostOnlyEntries ?? false,
      postOnlyRestBars: config.postOnlyRestBars ?? null,
      postOnlyHalfSpreadPercent: config.postOnlyHalfSpreadPercent ?? null,
      simulatedMakerFeePercent: config.simulatedMakerFeePercent ?? 0.02,
      simulatedTakerFeePercent: config.simulatedTakerFeePercent ?? 0.055,
      signalConfirmationTicks: config.signalConfirmationTicks ?? null,
    },
    perSymbol: reports,
    totals: {
      symbols: reports.length,
      closedTrades,
      winRate: closedTrades ? wins / closedTrades : 0,
      totalPnl, totalFees,
      restingPlaced, restingFilled,
      restingFillRate: restingPlaced ? restingFilled / restingPlaced : null,
      netReturnPercent, dailyReturnPercent,
    },
  };

  mkdirSync(a.out.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(a.out, JSON.stringify(artifact, null, 2));
  console.log(`\n  wrote ${a.out}`);

  if (closedTrades < 200) {
    console.log(`\n  ⚠️  ${closedTrades} closed trades is far too few to distinguish this result from`);
    console.log(`      chance. A fair coin over ${closedTrades} trades lands near this win rate routinely.`);
    console.log(`      Treat the net figure as "not yet measured", not as an edge.`);
  }
}

await main();
