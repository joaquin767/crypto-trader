// Information-driven bars — an alternative to sampling the market every N
// minutes.
//
// Time bars have a known statistical defect: markets don't deliver
// information at a constant rate, so a 5-minute bar oversamples dead
// periods and undersamples bursts. The resulting return series has fatter
// tails and worse normality than bars sampled by ACTIVITY.
//
// Dollar bars instead emit one observation every time a fixed notional
// value has traded. Quiet hours produce few bars, active ones produce many,
// so each bar carries roughly equal information. This is López de Prado's
// argument, and the same Financial Innovation study that validates the
// triple-barrier labelling this project uses also finds information-driven
// bars outperform time bars for crypto.
//
// Honest limitation: true dollar bars are built from TICK data. Built from
// 5-minute klines, as here, a dollar bar can only start and end on a 5m
// boundary — so this captures the variable-sampling benefit but not
// sub-5-minute resolution. It is an approximation, and a real one, not the
// full technique.

import type { Candle } from "./backtest.ts";

/**
 * Aggregate time-based candles into dollar bars: consecutive candles are
 * merged until their cumulative traded value (close x volume) reaches
 * `dollarThreshold`, then emitted as one bar.
 *
 * The emitted bar keeps true OHLC semantics — open of the first candle,
 * close of the last, max high, min low, summed volume — so everything
 * downstream (features, triple-barrier labelling) works unchanged.
 */
export function toDollarBars(candles: Candle[], dollarThreshold: number): Candle[] {
  if (dollarThreshold <= 0 || candles.length === 0) return [];

  const out: Candle[] = [];
  let acc: Candle | null = null;
  let accDollars = 0;

  for (const c of candles) {
    if (acc === null) {
      acc = { ...c };
      accDollars = 0;
    } else {
      acc.high = Math.max(acc.high, c.high);
      acc.low = Math.min(acc.low, c.low);
      acc.close = c.close;
      acc.volume += c.volume;
    }
    accDollars += c.close * c.volume;

    if (accDollars >= dollarThreshold) {
      out.push(acc);
      acc = null;
      accDollars = 0;
    }
  }
  // A trailing partial bar is deliberately discarded: it hasn't accumulated
  // its threshold of activity, so it isn't comparable to the others and
  // would be the one bar a live system hasn't finished forming either.
  return out;
}

/**
 * Choose a dollar threshold that yields roughly `targetBars` bars from this
 * series — so a symbol trading $50k/5min and one trading $5m/5min both get
 * a usable number of observations instead of one being starved.
 */
export function suggestDollarThreshold(candles: Candle[], targetBars: number): number {
  const total = candles.reduce((a, c) => a + c.close * c.volume, 0);
  return targetBars > 0 && total > 0 ? total / targetBars : 0;
}
