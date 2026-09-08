// Tick -> candle aggregation for live model inference.
//
// The model (src/strategy/model.ts) is trained on 5m OHLCV candles, so at
// inference time it must be fed 5m OHLCV candles built the same way — not
// raw ticks, and not some other bar definition. This module is the bridge:
// the live loop pushes ticks in, completed candles come out, and
// features.ts sees the same shape in production as it did in training.
//
// Without this, the model would score a feature vector drawn from a
// different distribution than it was fit on ("train/serve skew") and return
// confident nonsense.

import type { Candle } from "./backtest.ts";

export const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5m, matching the trained model

interface SymbolState {
  completed: Candle[];
  building: Candle | null;
  bucketStart: number;
  /** openTime of the newest completed candle the consumer has already acted
   *  on, so takeCompletedCandle() reports each bar exactly once. */
  lastConsumedOpenTime: number;
}

// A dollar-bar model compresses several time bars into one, so the window
// must hold enough TIME bars to still yield >= MIN_CANDLES dollar bars.
const MAX_RETAINED = 1200;

const state = new Map<string, SymbolState>();

const bucketFor = (timestamp: number, intervalMs: number): number =>
  Math.floor(timestamp / intervalMs) * intervalMs;

/**
 * Fold one tick into the current candle for `symbol`, completing and
 * rolling over the candle when the tick crosses into a new interval bucket.
 *
 * `volume` is the exchange's 24h rolling volume on most tickers rather than
 * per-tick traded size, so it's recorded as a level (last value wins for the
 * bar) — features.ts only ever uses it as a ratio against its own trailing
 * mean, which stays meaningful either way.
 */
export function recordTick(
  symbol: string, price: number, volume: number, timestamp: number,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (!Number.isFinite(price) || price <= 0) return;

  let s = state.get(symbol);
  if (!s) {
    s = { completed: [], building: null, bucketStart: 0, lastConsumedOpenTime: 0 };
    state.set(symbol, s);
  }

  const bucket = bucketFor(timestamp, intervalMs);

  if (s.building === null || bucket !== s.bucketStart) {
    if (s.building !== null) {
      s.completed.push(s.building);
      if (s.completed.length > MAX_RETAINED) s.completed = s.completed.slice(-MAX_RETAINED);
    }
    s.building = { openTime: bucket, open: price, high: price, low: price, close: price, volume };
    s.bucketStart = bucket;
    return;
  }

  s.building.high = Math.max(s.building.high, price);
  s.building.low = Math.min(s.building.low, price);
  s.building.close = price;
  s.building.volume = volume;
}

/**
 * Completed candles for `symbol`, oldest first. The in-progress candle is
 * deliberately excluded — a partial bar's high/low/close keep changing, and
 * feeding it to the model would score a bar the training labels never saw
 * in that state.
 */
export function getCandles(symbol: string): Candle[] {
  return state.get(symbol)?.completed ?? [];
}

/** Seed completed candles directly (backfill from REST klines, or tests). */
export function seedCandles(symbol: string, candles: Candle[]): void {
  const completed = candles.slice(-MAX_RETAINED);
  state.set(symbol, {
    completed,
    building: null,
    bucketStart: 0,
    // Backfilled history is already in the past — mark it consumed so a
    // restart doesn't immediately fire a decision on a stale bar. Only
    // genuinely new closes should trigger an evaluation.
    lastConsumedOpenTime: completed.length > 0 ? completed[completed.length - 1]!.openTime : 0,
  });
}

/**
 * Return the newest completed candle for `symbol` if it hasn't been reported
 * yet, otherwise null — i.e. "has a bar closed since you last asked?".
 *
 * This is what lets the live loop make its indicator-driven decisions once
 * per bar, the same cadence runBacktest() replays at, instead of once per
 * refreshIntervalMs tick. Each bar is handed out exactly once.
 */
export function takeCompletedCandle(symbol: string): Candle | null {
  const s = state.get(symbol);
  if (!s || s.completed.length === 0) return null;
  const newest = s.completed[s.completed.length - 1]!;
  if (newest.openTime <= s.lastConsumedOpenTime) return null;
  s.lastConsumedOpenTime = newest.openTime;
  return newest;
}

/** Clear all aggregation state (tests, and between backtest runs). */
export function clearCandles(): void {
  state.clear();
}
