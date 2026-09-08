import { test } from "node:test";
import assert from "node:assert/strict";
import { toDollarBars, suggestDollarThreshold } from "../src/strategy/bars.ts";
import type { Candle } from "../src/strategy/backtest.ts";

// Time bars oversample quiet periods and undersample active ones, which is
// why the return series they produce has worse statistical properties than
// bars sampled by traded value. These pin the aggregation's correctness —
// a dollar bar must still be a truthful OHLC summary of what it merged.

const bar = (i: number, o: number, h: number, l: number, c: number, v: number): Candle =>
  ({ openTime: i * 300_000, open: o, high: h, low: l, close: c, volume: v });

test("a dollar bar preserves true OHLC semantics of the candles it merges", () => {
  // Three bars, $100 of value each at close x volume = 10 x 10.
  const src = [bar(0, 10, 12, 9, 11, 10), bar(1, 11, 15, 8, 10, 10), bar(2, 10, 11, 7, 9, 10)];
  const out = toDollarBars(src, 250); // merges all three
  assert.equal(out.length, 1);
  const b = out[0]!;
  assert.equal(b.open, 10, "open comes from the FIRST merged candle");
  assert.equal(b.close, 9, "close comes from the LAST merged candle");
  assert.equal(b.high, 15, "high is the max across the window");
  assert.equal(b.low, 7, "low is the min across the window");
  assert.equal(b.volume, 30, "volume is summed");
});

test("more traded value produces more bars — sampling follows activity, not the clock", () => {
  const quiet = Array.from({ length: 40 }, (_, i) => bar(i, 10, 10, 10, 10, 1));    // $10/bar
  const busy = Array.from({ length: 40 }, (_, i) => bar(i, 10, 10, 10, 10, 20));    // $200/bar
  const threshold = 100;
  const quietBars = toDollarBars(quiet, threshold).length;
  const busyBars = toDollarBars(busy, threshold).length;
  assert(busyBars > quietBars,
    `an equally-long but busier period must yield more observations (busy=${busyBars} quiet=${quietBars})`);
});

test("a trailing partial bar is discarded, not emitted half-formed", () => {
  const src = [bar(0, 10, 10, 10, 10, 10), bar(1, 10, 10, 10, 10, 1)]; // $100 then $10
  const out = toDollarBars(src, 100);
  assert.equal(out.length, 1, "only the completed bar is emitted");
  assert.equal(out[0]!.volume, 10, "the trailing partial is not folded into it");
});

test("suggestDollarThreshold targets roughly the requested bar count", () => {
  const src = Array.from({ length: 100 }, (_, i) => bar(i, 10, 10, 10, 10, 10)); // $100 each
  const t = suggestDollarThreshold(src, 20);
  const got = toDollarBars(src, t).length;
  assert(Math.abs(got - 20) <= 2, `expected ~20 bars, got ${got}`);
});

test("degenerate inputs are refused rather than producing nonsense", () => {
  assert.deepEqual(toDollarBars([], 100), []);
  assert.deepEqual(toDollarBars([bar(0, 1, 1, 1, 1, 1)], 0), []);
  assert.equal(suggestDollarThreshold([], 10), 0);
});
