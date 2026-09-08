// Gate 0 — walk-forward validation CLI (specs/profit-target-roadmap.md §5).
//
// Writes a committed report to data/validation/. That report IS the gate
// artifact: no capital decision may cite a number that isn't in one.
//
// Usage:
//   node --experimental-strip-types scripts/walk-forward.ts \
//     --data data/klines-365 \
//     --symbols APTUSDT,ARBUSDT,LINKUSDT,OPUSDT,SOLUSDT \
//     --train-days 30 --test-days 7 --step-days 7

import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { loadModel, DEFAULT_MODEL_PATH } from "../src/strategy/model.ts";
import { runWalkForward } from "../src/strategy/walkforward.ts";

function get(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const symbols = get(argv, "--symbols", "").split(",").map(s => s.trim()).filter(Boolean);
  if (symbols.length === 0) {
    throw new Error("--symbols is required (no default universe — see spec §13)");
  }

  const configPath = get(argv, "--config", "./config.json");
  const base = loadConfig(configPath);
  // Strategy-variant overrides, so a candidate can be measured without
  // editing config.json (which holds live credentials and drives the bot).
  let config = argv.includes("--post-only-tp-exits")
    ? { ...base, usePostOnlyTakeProfitExits: true }
    : base;
  // Fee overrides exist for ONE purpose: measuring the upper bound on what
  // cost reduction can achieve. Setting both to 0 answers "would this
  // strategy make money if trading were free?" — which bounds every possible
  // fee-structure improvement at once, instead of testing them one at a time.
  // A zero-fee run is NOT a candidate strategy and can never clear a gate.
  const feeOverride = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? Number.parseFloat(argv[i + 1]!) : null;
  };
  const mk = feeOverride("--maker-fee"), tk = feeOverride("--taker-fee");
  if (mk !== null || tk !== null) {
    config = {
      ...config,
      simulatedMakerFeePercent: mk ?? config.simulatedMakerFeePercent ?? 0.02,
      simulatedTakerFeePercent: tk ?? config.simulatedTakerFeePercent ?? 0.055,
    };
  }

  // Barriers and bar geometry default to whatever the DEPLOYED model was
  // trained with, so Gate 0 measures the system as it actually stands rather
  // than a configuration nobody is running (spec §12: no tuning during Gate 0).
  const deployed = loadModel(DEFAULT_MODEL_PATH);
  const tp = Number.parseFloat(get(argv, "--tp", String(deployed?.trainedOn.takeProfitPercent ?? config.takeProfitPercent)));
  const sl = Number.parseFloat(get(argv, "--sl", String(deployed?.trainedOn.stopLossPercent ?? config.stopLossPercent)));
  const horizon = Number.parseInt(get(argv, "--horizon", String(deployed?.trainedOn.horizonBars ?? 7)), 10);
  const ratio = Number.parseFloat(get(argv, "--bars-ratio", String(deployed?.trainedOn.timeBarsPerDollarBar ?? 0)));

  const trainDays = Number.parseInt(get(argv, "--train-days", "30"), 10);
  const testDays = Number.parseInt(get(argv, "--test-days", "7"), 10);
  const stepDays = Number.parseInt(get(argv, "--step-days", "7"), 10);
  const dataDir = get(argv, "--data", "data/klines-365");
  const epochs = Number.parseInt(get(argv, "--epochs", "200"), 10);

  console.log(`Gate 0 — walk-forward validation`);
  console.log(`  data      ${dataDir}`);
  console.log(`  symbols   ${symbols.join(", ")}`);
  console.log(`  geometry  train ${trainDays}d / test ${testDays}d / step ${stepDays}d`);
  console.log(`  barriers  TP ${tp}% / SL ${sl}% / horizon ${horizon} bars`);
  console.log(`  bars      ${ratio > 1 ? `dollar, ${ratio.toFixed(2)} time bars per bar` : "time (5m)"}`);
  console.log(`  capital   $${config.maxCapitalUsd}  |  epochs ${epochs}`);
  console.log(`  fees      entry ${config.usePostOnlyEntries ? "maker (post-only)" : "taker"}, ` +
    `take-profit exit ${config.usePostOnlyTakeProfitExits ? "MAKER (post-only)" : "taker"}, ` +
    `stop/horizon exit taker (invariant)\n`);

  const started = Date.now();
  const report = await runWalkForward({
    dataDir, symbols, config,
    trainDays, testDays, stepDays,
    tp, sl, horizon, timeBarsPerDollarBar: ratio,
    epochs,
    onFold: (r, total) => {
      const el = ((Date.now() - started) / 1000).toFixed(0);
      console.log(
        `  fold ${String(r.fold.index + 1).padStart(2)}/${total}  ` +
        `${new Date(r.fold.testStart).toISOString().slice(0, 10)}  ` +
        `AUC ${r.testAuc.toFixed(3)}  ` +
        `${String(r.closedTrades).padStart(3)} trades  ` +
        `net ${r.netReturnPercent >= 0 ? "+" : ""}${r.netReturnPercent.toFixed(3)}%  ` +
        `(${el}s)`,
      );
    },
  });

  const out = get(argv, "--out", `data/validation/walk-forward-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(out.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(72)}`);
  console.log(`  folds              ${report.totalFolds}  (${report.positiveFolds} positive)`);
  console.log(`  closed trades      ${report.totalClosedTrades}`);
  console.log(`  median daily       ${report.medianDailyReturnPercent >= 0 ? "+" : ""}${report.medianDailyReturnPercent.toFixed(4)} %/day`);
  console.log(`  mean daily         ${report.meanDailyReturnPercent >= 0 ? "+" : ""}${report.meanDailyReturnPercent.toFixed(4)} %/day`);
  console.log(`  median AUC         ${report.medianAuc.toFixed(4)}`);
  console.log(`  sign-test p        ${report.signTestPValue.toFixed(4)}`);
  console.log(`  max drawdown       ${report.maxDrawdownPercent.toFixed(2)}%   (fold p90 ${report.foldDrawdownP90.toFixed(2)}%)`);
  console.log(`  top-symbol share   ${(report.topSymbolProfitShare * 100).toFixed(1)}% of positive P&L`);
  console.log(`  exit mix           TP ${(report.exitMix.takeProfit * 100).toFixed(1)}%  SL ${(report.exitMix.stopLoss * 100).toFixed(1)}%  horizon ${(report.exitMix.horizon * 100).toFixed(1)}%`);
  console.log(`  P&L by symbol      ${Object.entries(report.pnlBySymbol).map(([s, v]) => `${s} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`).join("  ")}`);
  console.log(`${"=".repeat(72)}`);
  console.log(`\n  VERDICT: ${report.verdict.toUpperCase()}`);
  console.log(`  ${report.verdictReason}`);
  console.log(`\n  wrote ${out}`);

  if (report.verdict !== "edge_confirmed") {
    console.log(`\n  This is a successful measurement, not a failure. Per spec §5 G0.6,`);
    console.log(`  a verdict other than edge_confirmed means no real capital: Gates 1`);
    console.log(`  and 2 do not start and the go-live in §8 does not happen.`);
  }
}

await main();
