// Feature extraction for the scalping model (see src/strategy/model.ts).
//
// The single most important property of this module: **training and live
// inference must call exactly this function, on exactly this candle shape.**
// A model trained on features computed one way and served features computed
// another way ("train/serve skew") fails silently — it produces confident,
// meaningless probabilities. So features are defined once, here, over a
// window of completed candles, and both scripts/train-model.ts and the live
// path (via src/strategy/candles.ts's tick aggregator) feed the same shape.
//
// Every feature is deliberately scale-free (a ratio, a z-score-ish quantity,
// or a bounded oscillator) so one model generalizes across symbols priced at
// $0.60 and $200 alike, rather than learning "APT costs less than SOL".

import { calcRSI, calcSMA, calcBollinger, calcATR, calcEMA } from "./indicators.ts";
import type { Candle } from "./backtest.ts";

/** Ordered feature names — the model's weight vector is in this order. */
export const FEATURE_NAMES = [
  "ret1", "ret3", "ret6", "ret12",
  "rsi", "macdHist", "bbPos", "bbWidth",
  "volRatio", "bodyRatio", "upperWick", "lowerWick",
  "atrPct", "distSma", "hourSin", "hourCos",
  // ── Order-flow proxies ────────────────────────────────────────────
  // Everything above is a lagging transformation of past PRICE. The
  // literature on short-horizon prediction is consistent that order flow —
  // who is actually hitting the bid vs lifting the offer — carries the
  // signal that price-derived indicators do not (see the research notes in
  // the project discussion: OFI has a near-linear relationship with
  // short-horizon returns and is "superior to lagging technical
  // indicators because it directly captures real-time market pressure").
  //
  // True OFI needs tick/L2 data, which historical klines do not carry. So
  // these are the honest OHLCV-computable PROXIES for buying vs selling
  // pressure — weaker than real order flow, but a genuinely different
  // information class from the price-shape features above.
  "clv",          // close location within the bar's range: +1 closed on the high, -1 on the low
  "clvVol",       // that, weighted by relative volume — pressure with conviction behind it
  "clvMean6",     // persistence of that pressure over 6 bars
  "volShock",     // volume vs its own recent norm, in log terms
  "rangeRatio",   // this bar's range vs recent average range — expansion or contraction
] as const;

export type FeatureName = typeof FEATURE_NAMES[number];

/** Minimum completed candles needed before features are meaningful. */
export const MIN_CANDLES = 30;

const safeDiv = (a: number, b: number, fallback = 0): number =>
  b === 0 || !Number.isFinite(b) ? fallback : a / b;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Compute the feature vector from a window of completed candles, using ONLY
 * candles up to and including the last one — never any forward-looking data.
 * `candles` must be chronological (oldest first).
 *
 * Returns null when there isn't enough history for the indicators to mean
 * anything, so callers fail closed (no trade) rather than acting on a vector
 * of zeros that the model will happily score.
 */
export function extractFeatures(candles: Candle[]): number[] | null {
  if (candles.length < MIN_CANDLES) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const last = candles[candles.length - 1]!;
  const price = last.close;
  if (!Number.isFinite(price) || price <= 0) return null;

  const atr = calcATR(highs, lows, closes, 14);
  const atrPct = safeDiv(atr, price) * 100;
  // Volatility-normalised returns: a 0.5% move means something very
  // different on a calm symbol than a thrashing one, and the model should
  // see "how big relative to normal", not raw percent.
  const volNorm = Math.max(atrPct, 0.01);

  const retOver = (bars: number): number => {
    const past = closes[closes.length - 1 - bars];
    if (past === undefined || past <= 0) return 0;
    return clamp(safeDiv((price - past) / past * 100, volNorm), -10, 10);
  };

  const rsi = calcRSI(closes, 14);
  const sma20 = calcSMA(closes, 20);
  const bb = calcBollinger(closes, 20, 2);
  const macdLine = calcEMA(closes, 12) - calcEMA(closes, 26);
  const macdSignal = calcEMA(closes.slice(0, -1), 12) - calcEMA(closes.slice(0, -1), 26);

  const range = last.high - last.low;
  const meanVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);

  const hour = new Date(last.openTime).getUTCHours();
  const hourAngle = (hour / 24) * 2 * Math.PI;

  // ── Order-flow proxies ──────────────────────────────────────────────
  // Close Location Value: where in the bar's range did it settle? Closing
  // near the high means buyers absorbed the bar; near the low, sellers did.
  // This is the standard OHLC stand-in for signed volume when tick data
  // isn't available.
  const clvOf = (c: Candle): number => {
    const r = c.high - c.low;
    return r === 0 ? 0 : ((c.close - c.low) - (c.high - c.close)) / r;
  };
  const clv = clvOf(last);
  const recent6 = candles.slice(-6);
  const clvMean6 = recent6.reduce((a, c) => a + clvOf(c), 0) / recent6.length;
  // Named relVol, not volNorm — volNorm above is the VOLATILITY normaliser
  // (ATR-based) used by the return features; this is relative VOLUME.
  const relVol = safeDiv(last.volume, meanVol, 1) || 1;
  const meanRange = candles.slice(-20).reduce((a, c) => a + (c.high - c.low), 0) / Math.min(20, candles.length);

  const features: number[] = [
    retOver(1),
    retOver(3),
    retOver(6),
    retOver(12),
    (rsi - 50) / 50,                                                  // [-1, 1]
    clamp(safeDiv((macdLine - macdSignal) / price * 100, volNorm), -10, 10),
    clamp(safeDiv(price - bb.lower, bb.upper - bb.lower, 0.5) * 2 - 1, -3, 3),
    clamp(bb.width * 100, 0, 50),                                     // band width as %
    clamp(Math.log(safeDiv(last.volume, meanVol, 1) || 1), -5, 5),
    clamp(safeDiv(last.close - last.open, range), -1, 1),
    clamp(safeDiv(last.high - Math.max(last.open, last.close), range), 0, 1),
    clamp(safeDiv(Math.min(last.open, last.close) - last.low, range), 0, 1),
    clamp(atrPct, 0, 20),
    clamp(safeDiv(price - sma20, atr), -10, 10),
    Math.sin(hourAngle),
    Math.cos(hourAngle),
    clamp(clv, -1, 1),
    clamp(clv * clamp(relVol, 0, 5), -5, 5),
    clamp(clvMean6, -1, 1),
    clamp(Math.log(relVol), -5, 5),
    clamp(safeDiv(range, meanRange, 1), 0, 10),
  ];

  return features.every(Number.isFinite) ? features : null;
}
