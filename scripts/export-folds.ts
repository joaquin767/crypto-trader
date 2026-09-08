// Fold export for the AUC feasibility test — specs/profit-target-roadmap.md §5.12.3.
//
// THE QUESTION: can ANY model on freely-available data reach out-of-sample
// AUC >= 0.58 on the deployed label? Below that, §5.12's arithmetic says no
// barrier, gate or cost structure can make the strategy profitable.
//
// ── THE METHODOLOGICAL CONSTRAINT ────────────────────────────────────────
// AUC is only comparable across models predicting the SAME label. So the
// triple-barrier label is HELD FIXED at the deployed geometry (TP 1.5% /
// SL 1.5% / horizon 7 dollar bars) for every candidate, and only the FEATURES
// and the MODEL CLASS vary. Changing the label would make 0.58 mean something
// different for each candidate and the comparison meaningless.
//
// Feature extraction stays in TypeScript — the same validated extractFeatures()
// the live engine uses — and only the model fitting moves to Python. That keeps
// the features identical across the two languages instead of reimplementing 21
// of them in pandas, which is the divergence trap the freqtrade cross-check
// already taught (crosscheck/README.md).
//
// Fold geometry is identical to Gate 0's: 30d train / 7d test / 7d step.
//
// Usage:
//   node --experimental-strip-types scripts/export-folds.ts \
//     --symbols APTUSDT,ARBUSDT,LINKUSDT,OPUSDT,SOLUSDT --features base,ctx,btc \
//     --out data/validation/folds

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractFeatures, FEATURE_NAMES, MIN_CANDLES } from "../src/strategy/features.ts";
import { labelTripleBarrier, DEFAULT_FEATURE_WINDOW } from "../src/strategy/training.ts";
import { toDollarBars, suggestDollarThreshold } from "../src/strategy/bars.ts";
import { buildFolds, DAY_MS } from "../src/strategy/walkforward.ts";
import type { Candle } from "../src/strategy/backtest.ts";

const RATIO = 6.81119432400473;   // deployed time-bars-per-dollar-bar
const TP = 1.5, SL = 1.5, HORIZON = 7;

function get(argv: string[], f: string, d: string): string {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
}

function readCandles(dir: string, sym: string): Candle[] {
  return (JSON.parse(readFileSync(`${dir}/${sym}-5m.json`, "utf-8")) as { candles: Candle[] }).candles;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const safe = (n: number, d: number, f = 0) => (Number.isFinite(d) && d !== 0 ? n / d : f);

// ── Extra feature block: longer context ──────────────────────────────────
// The 21 base features look back ~30 bars at most (EMA26 is the longest).
// Hypothesis: the label is a 4-hour-ahead question and the model is only
// shown ~18 hours of context; slower structure may carry information the
// short window cannot see.
const CTX_NAMES = [
  "ret24", "ret48", "ret96", "volRatio", "distSma50Atr", "distSma100Atr", "rangePos96",
];

function ctxFeatures(bars: Candle[]): number[] | null {
  const n = bars.length;
  if (n < 101) return null;
  const c = bars.map(b => b.close);
  const last = c[n - 1]!;
  if (!(last > 0)) return null;

  const retOver = (k: number) => {
    const p = c[n - 1 - k];
    return p && p > 0 ? ((last - p) / p) * 100 : 0;
  };
  const rets: number[] = [];
  for (let i = n - 49; i < n; i++) {
    const p = c[i - 1];
    if (p && p > 0) rets.push((c[i]! - p) / p);
  }
  const sd = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const volLong = sd(rets) || 1e-9;
  const volShort = sd(rets.slice(-12)) || 1e-9;

  const sma = (k: number) => c.slice(-k).reduce((a, b) => a + b, 0) / k;
  const atrProxy = volLong * last || 1e-9;

  const win = bars.slice(-96);
  const hi = Math.max(...win.map(b => b.high));
  const lo = Math.min(...win.map(b => b.low));

  const out = [
    clamp(safe(retOver(24), volLong * 100), -10, 10),
    clamp(safe(retOver(48), volLong * 100), -10, 10),
    clamp(safe(retOver(96), volLong * 100), -10, 10),
    clamp(safe(volShort, volLong, 1), 0, 5),
    clamp(safe(last - sma(50), atrProxy), -10, 10),
    clamp(safe(last - sma(100), atrProxy), -10, 10),
    clamp(safe(last - lo, hi - lo, 0.5) * 2 - 1, -1, 1),
  ];
  return out.every(Number.isFinite) ? out : null;
}

// ── Extra feature block: BTC market factor ───────────────────────────────
// Every mid-cap alt co-moves with BTC. This is genuinely NEW information —
// not derivable from the symbol's own OHLC at any lookback — and it is free.
// Hypothesis: knowing whether the market as a whole is moving separates a
// symbol-specific move (which may continue) from a beta move (which may not).
const BTC_NAMES = ["btcRet1", "btcRet6", "btcRet24", "btcCorr48", "residRet6"];

function btcFeatures(bars: Candle[], btc5m: Candle[]): number[] | null {
  const n = bars.length;
  if (n < 49) return null;
  // As-of join: the BTC 5m bar at or immediately before each dollar bar's
  // open. Never a later bar — that would be look-ahead.
  const asOf = (t: number): number => {
    let lo = 0, hi = btc5m.length - 1, best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (btc5m[m]!.openTime <= t) { best = m; lo = m + 1; } else hi = m - 1;
    }
    return best;
  };
  const idx: number[] = [];
  for (let i = n - 49; i < n; i++) {
    const j = asOf(bars[i]!.openTime);
    if (j < 0) return null;
    idx.push(j);
  }
  const bc = idx.map(j => btc5m[j]!.close);
  const bn = bc.length;
  const bLast = bc[bn - 1]!;
  if (!(bLast > 0)) return null;

  const bRet = (k: number) => {
    const p = bc[bn - 1 - k];
    return p && p > 0 ? ((bLast - p) / p) * 100 : 0;
  };

  const sRets: number[] = [], bRets: number[] = [];
  for (let i = 1; i < bn; i++) {
    const sPrev = bars[n - 49 + i - 1]!.close, sCur = bars[n - 49 + i]!.close;
    const bPrev = bc[i - 1]!;
    if (sPrev > 0 && bPrev > 0) { sRets.push((sCur - sPrev) / sPrev); bRets.push((bc[i]! - bPrev) / bPrev); }
  }
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
  const ms = mean(sRets), mb = mean(bRets);
  let cov = 0, vs = 0, vb = 0;
  for (let i = 0; i < sRets.length; i++) {
    cov += (sRets[i]! - ms) * (bRets[i]! - mb);
    vs += (sRets[i]! - ms) ** 2; vb += (bRets[i]! - mb) ** 2;
  }
  const corr = vs > 0 && vb > 0 ? cov / Math.sqrt(vs * vb) : 0;
  const beta = vb > 0 ? cov / vb : 0;

  const sRet6 = (() => {
    const p = bars[n - 7]?.close;
    return p && p > 0 ? ((bars[n - 1]!.close - p) / p) * 100 : 0;
  })();

  const out = [
    clamp(bRet(1), -10, 10),
    clamp(bRet(6), -20, 20),
    clamp(bRet(24), -40, 40),
    clamp(corr, -1, 1),
    clamp(sRet6 - beta * bRet(6), -20, 20),   // residual (idiosyncratic) move
  ];
  return out.every(Number.isFinite) ? out : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const symbols = get(argv, "--symbols", "").split(",").map(s => s.trim()).filter(Boolean);
  if (!symbols.length) throw new Error("--symbols required");
  const dataDir = get(argv, "--data", "data/klines-365");
  const outDir = get(argv, "--out", "data/validation/folds");
  const blocks = new Set(get(argv, "--features", "base,ctx,btc").split(",").map(s => s.trim()));

  const btc5m = blocks.has("btc") ? readCandles(dataDir, "BTCUSDT") : [];

  const names = [
    ...FEATURE_NAMES,
    ...(blocks.has("ctx") ? CTX_NAMES : []),
    ...(blocks.has("btc") ? BTC_NAMES : []),
  ];

  const raw: Record<string, Candle[]> = {};
  for (const s of symbols) raw[s] = readCandles(dataDir, s);
  const firstMs = Math.max(...symbols.map(s => raw[s]![0]!.openTime));
  const lastMs = Math.min(...symbols.map(s => raw[s]![raw[s]!.length - 1]!.openTime));
  const folds = buildFolds(firstMs, lastMs, 30, 7, 7);

  console.log(`Fold export — label FIXED at TP ${TP}% / SL ${SL}% / horizon ${HORIZON} dollar bars`);
  console.log(`  symbols  ${symbols.join(", ")}`);
  console.log(`  features ${[...blocks].join("+")} = ${names.length} columns`);
  console.log(`  folds    ${folds.length}\n`);

  mkdirSync(outDir, { recursive: true });
  const manifest = { featureNames: names, blocks: [...blocks], symbols, tp: TP, sl: SL, horizon: HORIZON, folds: folds.length };

  for (const fold of folds) {
    const rows: { split: "train" | "test"; x: number[]; y: number; t: number; sym: string }[] = [];

    for (const sym of symbols) {
      const all = raw[sym]!;
      // Threshold from the TRAINING window only, reused for test — the same
      // no-look-ahead rule walkforward.ts uses.
      const trainWin = all.filter(c => c.openTime >= fold.trainStart && c.openTime < fold.trainEnd);
      const th = suggestDollarThreshold(trainWin, Math.max(1, Math.floor(trainWin.length / RATIO)));

      for (const split of ["train", "test"] as const) {
        const [from, to] = split === "train"
          ? [fold.trainStart, fold.trainEnd]
          : [fold.testStart, fold.testEnd];
        const bars = toDollarBars(all.filter(c => c.openTime >= from && c.openTime < to), th);

        for (let i = 0; i < bars.length; i++) {
          const y = labelTripleBarrier(bars, i, TP, SL, HORIZON);
          if (y === null) continue;
          const start = Math.max(0, i + 1 - DEFAULT_FEATURE_WINDOW);
          if (i + 1 - start < MIN_CANDLES) continue;
          const win = bars.slice(start, i + 1);

          const base = extractFeatures(win);
          if (base === null) continue;
          let x = base;
          if (blocks.has("ctx")) { const e = ctxFeatures(win); if (e === null) continue; x = [...x, ...e]; }
          if (blocks.has("btc")) { const e = btcFeatures(win, btc5m); if (e === null) continue; x = [...x, ...e]; }
          rows.push({ split, x, y, t: bars[i]!.openTime, sym });
        }
      }
    }

    const tr = rows.filter(r => r.split === "train").sort((a, b) => a.t - b.t);
    const te = rows.filter(r => r.split === "test").sort((a, b) => a.t - b.t);
    writeFileSync(`${outDir}/fold-${String(fold.index).padStart(3, "0")}.json`, JSON.stringify({
      index: fold.index, ...fold,
      Xtr: tr.map(r => r.x), ytr: tr.map(r => r.y),
      Xte: te.map(r => r.x), yte: te.map(r => r.y), symte: te.map(r => r.sym),
    }));
    if (fold.index % 10 === 0) console.log(`  fold ${fold.index}: train ${tr.length}  test ${te.length}`);
  }

  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`\n  wrote ${folds.length} folds to ${outDir}/`);
}

await main();
