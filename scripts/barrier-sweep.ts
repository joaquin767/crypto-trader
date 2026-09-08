// Barrier-geometry sweep — specs/profit-target-roadmap.md §5.8 option (a),
// §10's candidate protocol.
//
// The one axis left after §5.10 closed the cost-structure axis. Gate 0's
// zero-fee run showed the strategy loses 0.1123 %/day even trading free, so
// the deficit is gross, not cost — this sweep asks whether a different barrier
// geometry (or a different model gate) has positive gross expectancy at all.
//
// ── DISCIPLINE (this is the point of the file) ────────────────────────────
// The candidate list below is PRE-REGISTERED: it is fixed in source, each
// entry carries the hypothesis it tests, and it is capped at 10 per §10. That
// matters because the failure mode here is not a bug, it is p-hacking — run
// enough geometries against one fold set and one will look good by chance.
// Guards, all from §10 / A-4:
//   1. Every candidate is declared before any is run, with a reason.
//   2. Every candidate is REPORTED, including losers — no quiet dropping.
//   3. Max 10 candidates against one fold set.
//   4. The winner is re-validated on symbols never used in training or
//      tuning (scripts/holdout-validate.ts), and must independently satisfy
//      G0.6 steps 2, 3 and 5 there.
//   5. Adoption still requires beating the incumbent by >= 0.01 pp/day.
//
// A candidate that wins here has NOT passed Gate 0. It has earned a held-out
// re-validation, nothing more.
//
// Usage:
//   node --experimental-strip-types scripts/barrier-sweep.ts \
//     --data data/klines-365 --symbols APTUSDT,ARBUSDT,LINKUSDT,OPUSDT,SOLUSDT

import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { runWalkForward } from "../src/strategy/walkforward.ts";
import type { WalkForwardReport } from "../src/strategy/walkforward.ts";
import type { Config } from "../src/config.ts";

interface Candidate {
  label: string;
  /** The hypothesis this tests. Required — a candidate without a stated
   *  reason is a grid-search cell, which is the thing being avoided. */
  hypothesis: string;
  tp: number; sl: number; horizon: number;
  /** Config overrides layered on the deployed config. */
  overrides?: Partial<Config>;
}

// Deployed geometry: TP 1.5 / SL 1.5 / horizon 7 dollar bars (~35 min/bar,
// so ~4h), entered on the top 5% of model scores.
//
// Break-even arithmetic that motivates several of these. For a driftless
// random walk with barriers a above and b below, P(take-profit first) =
// b/(a+b), while break-even needs w = (b+c)/(a+b) at round-trip cost c.
// The deficit is therefore c/(a+b) — independent of the RATIO, but shrinking
// as the TOTAL width grows. At c=0.0625%: 1.5/1.5 needs +2.08pp of skill over
// a coin flip, 3.0/3.0 needs +1.04pp, 4.0/4.0 needs +0.78pp.
const CANDIDATES: Candidate[] = [
  {
    label: "baseline-1.5/1.5-h7",
    hypothesis: "Incumbent. Everything else is measured against this.",
    tp: 1.5, sl: 1.5, horizon: 7,
  },
  {
    label: "no-model-gate",
    hypothesis:
      "DIAGNOSTIC: is the model helping or hurting? Gate 0 reports median fold AUC 0.5464 " +
      "(above chance) yet negative GROSS expectancy. Those are only consistent if the top-5% " +
      "tail the gate actually trades is unreliable even though the overall ranking is not. " +
      "If removing the gate improves things, the model is destroying value, not adding it.",
    tp: 1.5, sl: 1.5, horizon: 7,
    overrides: { useModelGate: false },
  },
  {
    label: "gate-top20pct",
    hypothesis:
      "Same tail question, weaker form: if the extreme tail is noisy but the ranking is real, " +
      "a looser gate should beat a tighter one.",
    tp: 1.5, sl: 1.5, horizon: 7,
    overrides: { modelTopPercentile: 20 },
  },
  {
    label: "gate-top50pct",
    hypothesis: "Near-neutral gate. Isolates the gate's contribution from the barrier geometry.",
    tp: 1.5, sl: 1.5, horizon: 7,
    overrides: { modelTopPercentile: 50 },
  },
  {
    label: "horizon-14",
    hypothesis:
      "19.3% of exits are horizon timeouts, which resolve at whatever price happens to be " +
      "there — near coin-flip, and labelled as losses in training regardless of actual P&L. " +
      "A longer horizon lets more paths resolve AT a barrier, where the edge (if any) lives.",
    tp: 1.5, sl: 1.5, horizon: 14,
  },
  {
    label: "horizon-28",
    hypothesis: "Same as horizon-14, pushed further, to see whether the effect is monotonic.",
    tp: 1.5, sl: 1.5, horizon: 28,
  },
  {
    label: "wide-3.0/3.0-h14",
    hypothesis:
      "Widening total barrier width halves the cost deficit (2.08pp -> 1.04pp of required " +
      "skill). Horizon doubled because wider barriers need longer to be reached.",
    tp: 3.0, sl: 3.0, horizon: 14,
  },
  {
    label: "wide-4.0/4.0-h28",
    hypothesis: "Widest sensible barrier: deficit falls to 0.78pp. Horizon scaled with width.",
    tp: 4.0, sl: 4.0, horizon: 28,
  },
  {
    label: "narrow-0.75/0.75-h7",
    hypothesis:
      "FALSIFICATION TEST: the deficit formula predicts narrow barriers are WORSE (4.17pp of " +
      "required skill). If this comes out best, the formula — and the reasoning behind the " +
      "wide candidates — is wrong and the whole sweep should be distrusted.",
    tp: 0.75, sl: 0.75, horizon: 7,
  },
  {
    label: "asym-3.0/1.0-h14",
    hypothesis:
      "Asymmetric: cut losers at 1%, let winners run to 3%. Break-even win rate drops to " +
      "26.6%. Tests whether the model's skill (such as it is) survives better at picking " +
      "'does not immediately drop 1%' than 'rises 1.5% before falling 1.5%'.",
    tp: 3.0, sl: 1.0, horizon: 14,
  },
];

function get(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const symbols = get(argv, "--symbols", "").split(",").map(s => s.trim()).filter(Boolean);
  if (symbols.length === 0) throw new Error("--symbols is required");

  if (CANDIDATES.length > 10) {
    throw new Error(`${CANDIDATES.length} candidates exceeds §10's cap of 10 against one fold set`);
  }

  const dataDir = get(argv, "--data", "data/klines-365");
  const base = loadConfig(get(argv, "--config", "./config.json"));
  const trainDays = Number.parseInt(get(argv, "--train-days", "30"), 10);
  const testDays = Number.parseInt(get(argv, "--test-days", "7"), 10);
  const stepDays = Number.parseInt(get(argv, "--step-days", "7"), 10);
  const ratio = Number.parseFloat(get(argv, "--bars-ratio", "6.81119432400473"));

  console.log(`Barrier-geometry sweep — ${CANDIDATES.length} pre-registered candidates`);
  console.log(`  symbols  ${symbols.join(", ")}`);
  console.log(`  geometry train ${trainDays}d / test ${testDays}d / step ${stepDays}d, ${symbols.length} symbols`);
  console.log(`  bars     dollar, ${ratio.toFixed(2)} time bars per bar\n`);

  const results: { candidate: Candidate; report: WalkForwardReport }[] = [];

  for (const c of CANDIDATES) {
    const config: Config = {
      ...base,
      takeProfitPercent: c.tp,
      stopLossPercent: c.sl,
      // Maker take-profit exits are kept on: §5.10 established they are
      // strictly correct and costless, just not sufficient on their own.
      usePostOnlyTakeProfitExits: true,
      ...c.overrides,
    };
    const started = Date.now();
    const report = await runWalkForward({
      dataDir, symbols, config,
      trainDays, testDays, stepDays,
      tp: c.tp, sl: c.sl, horizon: c.horizon,
      timeBarsPerDollarBar: ratio,
      epochs: 200,
    });
    results.push({ candidate: c, report });
    const el = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `  ${c.label.padEnd(22)} ${report.medianDailyReturnPercent >= 0 ? "+" : ""}` +
      `${report.medianDailyReturnPercent.toFixed(4)} %/day  ` +
      `${String(report.positiveFolds).padStart(2)}/${report.totalFolds} folds  ` +
      `${String(report.totalClosedTrades).padStart(5)} trades  ` +
      `AUC ${report.medianAuc.toFixed(3)}  ` +
      `p ${report.signTestPValue.toFixed(3)}  ` +
      `${report.verdict === "edge_confirmed" ? "EDGE" : report.verdict}  (${el}s)`,
    );
  }

  // Rank by the gate's own primary statistic.
  const ranked = [...results].sort(
    (a, b) => b.report.medianDailyReturnPercent - a.report.medianDailyReturnPercent,
  );
  const best = ranked[0]!;
  const baseline = results.find(r => r.candidate.label.startsWith("baseline"))!;
  const improvement = best.report.medianDailyReturnPercent - baseline.report.medianDailyReturnPercent;

  console.log(`\n${"=".repeat(78)}`);
  console.log(`  best        ${best.candidate.label}  ${best.report.medianDailyReturnPercent.toFixed(4)} %/day`);
  console.log(`  baseline    ${baseline.report.medianDailyReturnPercent.toFixed(4)} %/day`);
  console.log(`  improvement ${improvement >= 0 ? "+" : ""}${improvement.toFixed(4)} pp/day (§10 adoption margin: 0.01)`);
  console.log(`${"=".repeat(78)}`);

  if (best.report.verdict !== "edge_confirmed") {
    console.log(`\n  NO CANDIDATE CLEARED GATE 0. The best is still '${best.report.verdict}':`);
    console.log(`  ${best.report.verdictReason}`);
    console.log(`\n  Held-out re-validation is not warranted — there is nothing to re-validate.`);
  } else if (improvement < 0.01) {
    console.log(`\n  Best candidate clears Gate 0 but improves on the incumbent by only`);
    console.log(`  ${improvement.toFixed(4)} pp/day, below §10's 0.01 margin. NOT adopted.`);
  } else {
    console.log(`\n  '${best.candidate.label}' clears Gate 0 and beats the incumbent by`);
    console.log(`  ${improvement.toFixed(4)} pp/day. NEXT STEP IS MANDATORY, not optional:`);
    console.log(`  re-validate on held-out symbols before adopting anything.`);
  }

  const out = get(argv, "--out", `data/validation/barrier-sweep-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(out.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    kind: "barrier-sweep",
    protocol: {
      note: "Candidates pre-registered in scripts/barrier-sweep.ts before any was run. " +
        "All are reported, including losers. Winning here does not clear Gate 0 and does not " +
        "authorise adoption; see §10 and A-4.",
      candidatesEvaluated: CANDIDATES.length,
      cap: 10,
      adoptionMarginPpPerDay: 0.01,
      symbols, trainDays, testDays, stepDays,
    },
    // Every candidate, in declared order — never filtered to the winners.
    candidates: results.map(({ candidate, report }) => ({
      label: candidate.label,
      hypothesis: candidate.hypothesis,
      tp: candidate.tp, sl: candidate.sl, horizon: candidate.horizon,
      overrides: candidate.overrides ?? {},
      medianDailyReturnPercent: report.medianDailyReturnPercent,
      meanDailyReturnPercent: report.meanDailyReturnPercent,
      positiveFolds: report.positiveFolds,
      totalFolds: report.totalFolds,
      totalClosedTrades: report.totalClosedTrades,
      medianAuc: report.medianAuc,
      signTestPValue: report.signTestPValue,
      maxDrawdownPercent: report.maxDrawdownPercent,
      topSymbolProfitShare: report.topSymbolProfitShare,
      exitMix: report.exitMix,
      pnlBySymbol: report.pnlBySymbol,
      verdict: report.verdict,
      verdictReason: report.verdictReason,
      adopted: false,
    })),
    best: best.candidate.label,
    improvementVsBaseline: improvement,
  }, null, 2));
  console.log(`\n  wrote ${out}`);
}

await main();
