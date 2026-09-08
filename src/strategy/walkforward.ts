// Walk-forward validation — specs/profit-target-roadmap.md Gate 0.
//
// The problem this exists to solve (F1): every performance figure this project
// has ever produced came from ONE chronological split, over ONE 15-day window,
// in ONE market regime — and the resulting headline turned out to be carried
// entirely by a single symbol (F0). A number like that cannot tell you whether
// a strategy generalises; it can only tell you what happened once.
//
// Here, the model is retrained from scratch on each fold's training window and
// evaluated ONLY on the untouched window immediately after it. Repeated across
// the whole history, that yields a DISTRIBUTION of out-of-sample returns rather
// than a point estimate — which is the difference between "we measured an edge"
// and "we observed a number."
//
// Determinism is a hard requirement, not a nicety: same inputs must give
// bit-identical output (except generatedAt), or the gate could be passed by
// re-rolling. training.ts's fit() has no RNG and no shuffling for this reason.

import { readFileSync, existsSync } from "node:fs";
import { buildSamples, fit, evaluate, medianBarMs, DEFAULT_FEATURE_WINDOW } from "./training.ts";
import type { Sample, TrainParams, FitResult } from "./training.ts";
import { toDollarBars, suggestDollarThreshold } from "./bars.ts";
import { FEATURE_NAMES } from "./features.ts";
import { runBacktest } from "./backtest.ts";
import type { Candle, BacktestReport } from "./backtest.ts";
import type { ModelWeights } from "./model.ts";
import type { Config } from "../config.ts";

/** Day→ms. All Fold bounds are ms epoch; all *Days params are whole days. */
export const DAY_MS = 86_400_000;

export class WalkForwardError extends Error {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property: node's --experimental-strip-types rejects those outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), and tsc --noEmit does NOT catch it.
  readonly foldIndex: number | null;
  constructor(message: string, foldIndex: number | null = null) {
    super(message);
    this.name = "WalkForwardError";
    this.foldIndex = foldIndex;
  }
}

export interface Fold {
  index: number;
  /** ms epoch, half-open [start, end). */
  trainStart: number; trainEnd: number;
  testStart: number;  testEnd: number;
}

export interface ExitMix { takeProfit: number; stopLoss: number; horizon: number }

export interface FoldResult {
  fold: Fold;
  trainSamples: number;
  testSamples: number;
  testAuc: number;
  testBaseRate: number;
  perSymbol: Record<string, BacktestReport>;
  closedTrades: number;
  netReturnPercent: number;
  dailyReturnPercent: number;
  pnlBySymbol: Record<string, number>;
  exitMix: ExitMix;
}

export interface CandidateRecord {
  label: string;
  medianDailyReturnPercent: number;
  maxDrawdownPercent: number;
  adopted: boolean;
}

export interface WalkForwardReport {
  generatedAt: string;
  command: string;
  symbols: string[];
  trainDays: number; testDays: number; stepDays: number;
  folds: FoldResult[];
  totalFolds: number;
  positiveFolds: number;
  medianDailyReturnPercent: number;
  meanDailyReturnPercent: number;
  medianAuc: number;
  totalClosedTrades: number;
  maxDrawdownPercent: number;
  foldDrawdownP90: number;
  pnlBySymbol: Record<string, number>;
  topSymbolProfitShare: number;
  exitMix: ExitMix;
  restingFillRate: number | null;
  signTestPValue: number;
  candidatesEvaluated: number;
  candidates: CandidateRecord[];
  verdict: "edge_confirmed" | "no_edge" | "insufficient_data";
  verdictReason: string;
}

// ── small statistics, implemented inline rather than adding a dependency ──

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  // Even-length median is the mean of the two central values (G0.6 step 2).
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

/**
 * One-sided upper tail of a Binomial(n, 0.5), INCLUSIVE of k:
 * P(X >= k). Computed with a log-gamma binomial coefficient so n in the
 * hundreds doesn't overflow.
 */
export function binomialUpperTail(k: number, n: number): number {
  if (n <= 0) return 1;
  if (k <= 0) return 1;
  if (k > n) return 0;
  const logC = (a: number, b: number) => lgamma(a + 1) - lgamma(b + 1) - lgamma(a - b + 1);
  let total = 0;
  for (let i = k; i <= n; i++) total += Math.exp(logC(n, i) + n * Math.log(0.5));
  return Math.min(1, total);
}

/** Lanczos log-gamma — enough precision for binomial coefficients here. */
function lgamma(z: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j]! / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// ── fold construction ─────────────────────────────────────────────────────

/**
 * Chronological folds over [firstMs, lastMs). Returns [] if fewer than one
 * full train+test window fits — never a partial fold and never a silently
 * shortened training window, because a fold trained on less data than its
 * peers would quietly contaminate the fold distribution the gate reads.
 */
export function buildFolds(
  firstMs: number, lastMs: number,
  trainDays: number, testDays: number, stepDays: number,
): Fold[] {
  if (!(trainDays > 0 && testDays > 0 && stepDays > 0)) {
    throw new WalkForwardError(`trainDays/testDays/stepDays must all be > 0 (got ${trainDays}/${testDays}/${stepDays})`);
  }
  const folds: Fold[] = [];
  const train = trainDays * DAY_MS, test = testDays * DAY_MS, step = stepDays * DAY_MS;
  let index = 0;
  for (let trainStart = firstMs; trainStart + train + test <= lastMs; trainStart += step) {
    folds.push({
      index: index++,
      trainStart, trainEnd: trainStart + train,
      testStart: trainStart + train, testEnd: trainStart + train + test,
    });
  }
  return folds;
}

// ── data loading ──────────────────────────────────────────────────────────

interface SymbolData { symbol: string; candles: Candle[] }

function loadSymbols(dataDir: string, symbols: string[], interval = "5"): SymbolData[] {
  const out: SymbolData[] = [];
  for (const symbol of symbols) {
    const path = `${dataDir}/${symbol}-${interval}m.json`;
    if (!existsSync(path)) {
      throw new WalkForwardError(`missing kline file for ${symbol}: ${path} — run scripts/fetch-klines.ts first`);
    }
    let parsed: { symbol: string; candles: Candle[] };
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8")) as { symbol: string; candles: Candle[] };
    } catch (err) {
      throw new WalkForwardError(`unparseable kline file for ${symbol}: ${path} (${(err as Error).message})`);
    }
    if (!Array.isArray(parsed.candles) || parsed.candles.length === 0) {
      throw new WalkForwardError(`kline file for ${symbol} contains no candles: ${path}`);
    }
    out.push({ symbol, candles: parsed.candles });
  }
  return out;
}

/** Bars with openTime in [from, to). */
const slice = (candles: Candle[], from: number, to: number): Candle[] =>
  candles.filter(c => c.openTime >= from && c.openTime < to);

// ── the harness ───────────────────────────────────────────────────────────

export interface WalkForwardOptions {
  dataDir: string;
  symbols: string[];
  config: Config;
  trainDays: number;
  testDays: number;
  stepDays: number;
  tp: number; sl: number; horizon: number;
  /** Time bars per dollar bar. Held CONSTANT across folds so a dollar bar
   *  means the same wall-clock duration in every fold regardless of window
   *  length — otherwise the horizon (measured in bars) would silently
   *  represent different real durations fold to fold. 0 = plain time bars. */
  timeBarsPerDollarBar: number;
  epochs?: number; lr?: number; l2?: number;
  featureWindow?: number;
  interval?: string;
  /** Called after each fold so a long run reports progress. */
  onFold?: (r: FoldResult, total: number) => void;
}

/**
 * Convert one symbol's window to the bar type the model is trained on.
 *
 * `threshold` is supplied by the caller rather than derived here so a TEST
 * window can be bucketed with the THRESHOLD FROM ITS TRAINING WINDOW. Deriving
 * it from the test window itself would let the test period's own volume
 * distribution shape the features it is scored on — a subtle look-ahead that
 * would inflate testAuc without ever showing up as an obvious bug.
 */
function toBars(candles: Candle[], threshold: number): Candle[] {
  return threshold > 0 ? toDollarBars(candles, threshold) : candles;
}

export async function runWalkForward(opts: WalkForwardOptions): Promise<WalkForwardReport> {
  const {
    dataDir, symbols, config, trainDays, testDays, stepDays,
    tp, sl, horizon, timeBarsPerDollarBar,
    epochs = 200, lr = 0.1, l2 = 0.001,
    featureWindow = DEFAULT_FEATURE_WINDOW, interval = "5",
  } = opts;

  const params: TrainParams = { tp, sl, horizon, epochs, lr, l2, dollarBars: timeBarsPerDollarBar, featureWindow };
  const data = loadSymbols(dataDir, symbols, interval);

  // Fold over the INTERSECTION of the symbols' spans, so every fold has every
  // symbol. Using the union would silently weight the pooled result toward
  // whichever symbol has the longest history (spec Q-1).
  const firstMs = Math.max(...data.map(d => d.candles[0]!.openTime));
  const lastMs = Math.min(...data.map(d => d.candles[d.candles.length - 1]!.openTime));

  const command =
    `node --experimental-strip-types scripts/walk-forward.ts --data ${dataDir} ` +
    `--symbols ${symbols.join(",")} --train-days ${trainDays} --test-days ${testDays} --step-days ${stepDays}`;

  const folds = buildFolds(firstMs, lastMs, trainDays, testDays, stepDays);
  if (folds.length === 0) {
    return emptyReport(command, opts, "insufficient_data",
      `no complete ${trainDays}+${testDays} day window fits in the ${((lastMs - firstMs) / DAY_MS).toFixed(1)} days available`);
  }

  const results: FoldResult[] = [];

  for (const fold of folds) {
    // ── train ────────────────────────────────────────────────────────────
    // Per-symbol dollar threshold, derived ONLY from this fold's training
    // window, and reused for the test window (see toBars).
    const thresholds: Record<string, number> = {};
    const trainBars: Record<string, Candle[]> = {};
    for (const { symbol, candles } of data) {
      const window = slice(candles, fold.trainStart, fold.trainEnd);
      const threshold = timeBarsPerDollarBar > 1
        ? suggestDollarThreshold(window, Math.max(1, Math.floor(window.length / timeBarsPerDollarBar)))
        : 0;
      thresholds[symbol] = threshold;
      trainBars[symbol] = toBars(window, threshold);
    }

    const trainSamples = buildSamples(trainBars, params);
    if (trainSamples.length < 1000) {
      throw new WalkForwardError(
        `fold ${fold.index} train window has ${trainSamples.length} samples (< 1000)`, fold.index);
    }
    // Chronological order across symbols, matching train-model.ts.
    trainSamples.sort((a, b) => a.t - b.t);
    const fitted = fit(trainSamples, params);

    // ── evaluate ─────────────────────────────────────────────────────────
    const testBars: Record<string, Candle[]> = {};
    for (const { symbol, candles } of data) {
      testBars[symbol] = toBars(slice(candles, fold.testStart, fold.testEnd), thresholds[symbol]!);
    }
    const testSamples = buildSamples(testBars, params);
    const ev = evaluate(testSamples, fitted);

    const model = toModelWeights(fitted, params, symbols, trainBars, interval);

    // ── backtest the test window with THIS fold's model ───────────────────
    // Sequential by necessity: runBacktest owns module-level indicator,
    // candle and threshold state for its duration.
    const perSymbol: Record<string, BacktestReport> = {};
    const pnlBySymbol: Record<string, number> = {};
    for (const { symbol, candles } of data) {
      // Time bars, not dollar bars: runBacktest replays the live loop, which
      // consumes 5m candles and does its own dollar-bar bucketing internally.
      const window = slice(candles, fold.testStart, fold.testEnd);
      const report = await runBacktest(window, symbol, config, model);
      perSymbol[symbol] = report;
      pnlBySymbol[symbol] = report.totalPnl;
    }

    const closedTrades = Object.values(perSymbol).reduce((s, r) => s + r.closedTrades, 0);
    const totalPnl = Object.values(perSymbol).reduce((s, r) => s + r.totalPnl, 0);
    const netReturnPercent = (totalPnl / config.maxCapitalUsd) * 100;
    const testDaysActual = (fold.testEnd - fold.testStart) / DAY_MS;

    const result: FoldResult = {
      fold,
      trainSamples: trainSamples.length,
      testSamples: ev.n,
      testAuc: ev.auc,
      testBaseRate: ev.baseRate,
      perSymbol,
      closedTrades,
      netReturnPercent,
      dailyReturnPercent: testDaysActual > 0 ? netReturnPercent / testDaysActual : 0,
      pnlBySymbol,
      exitMix: mixOf(Object.values(perSymbol).flatMap(r => r.trades)),
    };
    results.push(result);
    opts.onFold?.(result, folds.length);
  }

  return summarise(command, opts, results);
}

function toModelWeights(
  f: FitResult, p: TrainParams, symbols: string[],
  trainBars: Record<string, Candle[]>, interval: string,
): ModelWeights {
  // Median of each symbol's OWN median bar duration.
  //
  // Not the median of all symbols' bar times pooled together: interleaving 5
  // symbols' bars into one sorted series makes consecutive gaps ~1/5 of the
  // real per-symbol gap, which measured 5.0 min/bar where the true figure is
  // 35.0. Since horizonBars is converted to wall-clock via avgBarMs, that
  // understated the model's exit horizon by 7x.
  const perSymbolBarMs = Object.values(trainBars)
    .map(bars => medianBarMs(bars.map(b => b.openTime)))
    .filter(ms => ms > 0)
    .sort((a, b) => a - b);
  const barMs = perSymbolBarMs.length > 0
    ? perSymbolBarMs[perSymbolBarMs.length >> 1]!
    : 5 * 60_000;
  return {
    version: 1,
    featureNames: [...FEATURE_NAMES],
    weights: f.weights, bias: f.bias, mean: f.mean, std: f.std,
    trainedOn: {
      symbols: [...symbols],
      interval,
      candles: Object.values(trainBars).reduce((s, b) => s + b.length, 0),
      takeProfitPercent: p.tp,
      stopLossPercent: p.sl,
      horizonBars: p.horizon,
      timeBarsPerDollarBar: p.dollarBars,
      avgBarMs: p.dollarBars > 1 ? barMs : 5 * 60_000,
    },
    metrics: { trainAccuracy: 0, testAccuracy: 0, testAuc: 0, testBaseRate: 0, testSamples: 0 },
  };
}

function mixOf(trades: { exitReason: string }[]): ExitMix {
  const n = trades.length;
  if (n === 0) return { takeProfit: 0, stopLoss: 0, horizon: 0 };
  const c = (r: string) => trades.filter(t => t.exitReason === r).length / n;
  return { takeProfit: c("take_profit"), stopLoss: c("stop_loss"), horizon: c("horizon") };
}

function emptyReport(
  command: string, opts: WalkForwardOptions,
  verdict: WalkForwardReport["verdict"], verdictReason: string,
): WalkForwardReport {
  return {
    generatedAt: new Date().toISOString(), command,
    symbols: opts.symbols, trainDays: opts.trainDays, testDays: opts.testDays, stepDays: opts.stepDays,
    folds: [], totalFolds: 0, positiveFolds: 0,
    medianDailyReturnPercent: 0, meanDailyReturnPercent: 0, medianAuc: 0.5,
    totalClosedTrades: 0, maxDrawdownPercent: 0, foldDrawdownP90: 0,
    pnlBySymbol: {}, topSymbolProfitShare: 0,
    exitMix: { takeProfit: 0, stopLoss: 0, horizon: 0 }, restingFillRate: null,
    signTestPValue: 1, candidatesEvaluated: 1, candidates: [],
    verdict, verdictReason,
  };
}

function summarise(
  command: string, opts: WalkForwardOptions, folds: FoldResult[],
): WalkForwardReport {
  const dailies = folds.map(f => f.dailyReturnPercent);
  const positiveFolds = folds.filter(f => f.netReturnPercent > 0).length;
  const totalFolds = folds.length;
  const totalClosedTrades = folds.reduce((s, f) => s + f.closedTrades, 0);

  const pnlBySymbol: Record<string, number> = {};
  for (const f of folds) {
    for (const [sym, pnl] of Object.entries(f.pnlBySymbol)) {
      pnlBySymbol[sym] = (pnlBySymbol[sym] ?? 0) + pnl;
    }
  }
  // Concentration is measured against POSITIVE P&L only: the question F0 asks
  // is "is the profit coming from one symbol", and netting losers into the
  // denominator would let a big loser mask a concentrated winner.
  const positivePnl = Object.values(pnlBySymbol).filter(v => v > 0);
  const positiveTotal = positivePnl.reduce((a, b) => a + b, 0);
  const topSymbolProfitShare = positiveTotal > 0 ? Math.max(...positivePnl) / positiveTotal : 0;

  // Cross-fold drawdown: merge every closed trade, order by exit time, and
  // run the equity forward. Per-fold drawdowns understate the real thing,
  // because a losing run that straddles a fold boundary is invisible to both.
  const allTrades = folds
    .flatMap(f => Object.values(f.perSymbol).flatMap(r => r.trades))
    .sort((a, b) => a.exitTime - b.exitTime);
  const capital = opts.config.maxCapitalUsd;
  let equity = capital, peak = capital, maxDd = 0;
  for (const t of allTrades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }

  const placed = folds.reduce((s, f) => s + Object.values(f.perSymbol).reduce((a, r) => a + (r.restingPlaced ?? 0), 0), 0);
  const filled = folds.reduce((s, f) => s + Object.values(f.perSymbol).reduce((a, r) => a + (r.restingFilled ?? 0), 0), 0);

  const medianDailyReturnPercent = median(dailies);
  const signTestPValue = binomialUpperTail(positiveFolds, totalFolds);

  // ── G0.6 kill criterion, in order. First match decides. ────────────────
  let verdict: WalkForwardReport["verdict"];
  let verdictReason: string;
  if (totalFolds < 20 || totalClosedTrades < 200) {
    verdict = "insufficient_data";
    verdictReason = `step 1: totalFolds=${totalFolds} (<20) or totalClosedTrades=${totalClosedTrades} (<200)`;
  } else if (medianDailyReturnPercent <= 0) {
    verdict = "no_edge";
    verdictReason = `step 2: medianDailyReturnPercent=${medianDailyReturnPercent.toFixed(4)} <= 0`;
  } else if (positiveFolds / totalFolds < 0.55) {
    verdict = "no_edge";
    verdictReason = `step 3: positiveFolds ${positiveFolds}/${totalFolds} = ${(positiveFolds / totalFolds).toFixed(3)} < 0.55`;
  } else if (signTestPValue > 0.10) {
    verdict = "no_edge";
    verdictReason = `step 4: signTestPValue=${signTestPValue.toFixed(4)} > 0.10`;
  } else if (topSymbolProfitShare > 0.60) {
    verdict = "no_edge";
    verdictReason = `step 5: single-symbol concentration, topSymbolProfitShare=${topSymbolProfitShare.toFixed(3)} > 0.60`;
  } else {
    verdict = "edge_confirmed";
    verdictReason = `step 6: median ${medianDailyReturnPercent.toFixed(4)}%/day over ${totalFolds} folds, ` +
      `${positiveFolds} positive, p=${signTestPValue.toFixed(4)}, top-symbol share ${topSymbolProfitShare.toFixed(3)}`;
  }

  return {
    generatedAt: new Date().toISOString(), command,
    symbols: opts.symbols, trainDays: opts.trainDays, testDays: opts.testDays, stepDays: opts.stepDays,
    folds, totalFolds, positiveFolds,
    medianDailyReturnPercent,
    meanDailyReturnPercent: dailies.reduce((a, b) => a + b, 0) / Math.max(1, dailies.length),
    medianAuc: median(folds.map(f => f.testAuc)),
    totalClosedTrades,
    maxDrawdownPercent: maxDd,
    foldDrawdownP90: percentile(folds.map(f =>
      Math.max(...Object.values(f.perSymbol).map(r => r.maxDrawdownPercent), 0)), 0.9),
    pnlBySymbol, topSymbolProfitShare,
    exitMix: mixOf(allTrades),
    restingFillRate: placed > 0 ? filled / placed : null,
    signTestPValue,
    candidatesEvaluated: 1, candidates: [],
    verdict, verdictReason,
  };
}
