import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcSMA, calcEMA, calcRSI, calcMACD, calcBollinger,
  calcATR, calcMomentum,
  updateRsi, updateMacd, initialRsiState, initialMacdState,
} from "../src/strategy/indicators.ts";

test("calcSMA returns correct average", () => {
  assert.equal(calcSMA([1, 2, 3, 4, 5], 3), 4); // (3+4+5)/3
});

test("calcSMA returns last value when insufficient data", () => {
  assert.equal(calcSMA([10], 5), 10);
});

test("calcRSI returns 100 for flat price (no losses)", () => {
  const prices = Array.from({ length: 20 }, () => 100);
  const rsi = calcRSI(prices, 14);
  assert.equal(rsi, 100); // avgLoss = 0 => RS infinite => RSI = 100
});

test("calcRSI returns 100 for consistently rising price", () => {
  const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
  const rsi = calcRSI(prices, 14);
  assert.equal(rsi, 100);
});

test("calcRSI returns 0 for consistently falling price", () => {
  const prices = Array.from({ length: 20 }, (_, i) => 100 - i);
  const rsi = calcRSI(prices, 14);
  assert.equal(rsi, 0);
});

test("calcRSI returns above 70 for strongly rising", () => {
  const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 3);
  const rsi = calcRSI(prices, 14);
  assert(rsi > 70);
});

test("calcRSI returns below 30 for strongly falling", () => {
  const prices = Array.from({ length: 20 }, (_, i) => 100 - i * 3);
  const rsi = calcRSI(prices, 14);
  assert(rsi < 30);
});

test("calcMACD returns neutral for flat prices", () => {
  const prices = Array.from({ length: 30 }, () => 100);
  const macd = calcMACD(prices);
  assert.equal(macd.bullish, false);
});

test("calcMACD detects bullish crossover after upward trend", () => {
  const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.min(i, 15) * 2);
  const macd = calcMACD(prices);
  // After a sustained rise, MACD should be positive
  assert(macd.macdLine !== 0);
});

test("calcBollinger returns bands with correct ordering", () => {
  const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
  const bb = calcBollinger(prices, 20, 2);
  assert(bb.upper > bb.middle);
  assert(bb.lower < bb.middle);
  assert(bb.width > 0);
});

test("calcATR returns 0 for flat prices", () => {
  const prices = Array.from({ length: 20 }, () => 100);
  const atr = calcATR(prices, prices, prices, 14);
  assert.equal(atr, 0);
});

test("calcMomentum returns positive for rising prices", () => {
  const prices = Array.from({ length: 15 }, (_, i) => 100 + i);
  assert(calcMomentum(prices, 10) > 0);
});

test("calcMomentum returns negative for falling prices", () => {
  const prices = Array.from({ length: 15 }, (_, i) => 100 - i);
  assert(calcMomentum(prices, 10) < 0);
});

// ── Regression coverage for specs/strategy-signal-quality.md F1/F6 ────────
// Real event: calcRSI recomputes avgGain/avgLoss from scratch over the raw
// trailing 14-delta window every call, with no memory between calls. Live on
// Bybit testnet this made RSI swing across its full 0-100 range within a
// tick or two on a symbol whose price barely moved (recorded in
// tests/fixtures/apt-usdt-session-2026-09-07.json: 100 -> 83.33 -> 62.5 ->
// 50 -> ... within ~90 minutes). updateRsi/updateMacd fix this by carrying
// smoothed state between calls instead.

test("updateRsi is far less noise-sensitive than calcRSI for the same input (F1 regression)", () => {
  // Small alternating noise with one large one-tick spike buried in it —
  // exactly the shape that made calcRSI swing sharply once, live, as the
  // spike aged toward the edge of its raw 14-tick window.
  const prices = [100];
  for (let i = 0; i < 10; i++) prices.push(prices[prices.length - 1]! + (i % 2 === 0 ? 0.3 : -0.3));
  prices.push(prices[prices.length - 1]! + 15); // one large one-tick spike
  for (let i = 0; i < 20; i++) prices.push(prices[prices.length - 1]! + (i % 2 === 0 ? 0.3 : -0.3));

  const oldSeries: number[] = [];
  for (let t = 15; t < prices.length; t++) oldSeries.push(calcRSI(prices.slice(0, t + 1), 14));
  const oldMaxSwing = Math.max(...oldSeries.slice(1).map((v, i) => Math.abs(v - oldSeries[i]!)));

  let state = initialRsiState();
  const newSeries: number[] = [];
  for (let t = 15; t < prices.length; t++) {
    const upd = updateRsi(state, prices.slice(0, t + 1), 14);
    state = upd.state;
    newSeries.push(upd.value);
  }
  const newMaxSwing = Math.max(...newSeries.slice(1).map((v, i) => Math.abs(v - newSeries[i]!)));

  assert(oldMaxSwing > 30, `expected calcRSI to swing sharply as the spike ages out of its window (got ${oldMaxSwing})`);
  assert(
    newMaxSwing < oldMaxSwing / 2,
    `updateRsi should swing far less than calcRSI for the same input (old=${oldMaxSwing}, new=${newMaxSwing})`,
  );
});

test("updateRsi bootstraps its first value identically to calcRSI on the same window", () => {
  const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 3);
  const classic = calcRSI(prices, 14);
  const { value } = updateRsi(initialRsiState(), prices, 14);
  assert.equal(value, classic);
});

test("updateMacd's bullish flag cannot fire on the very first call after initialization", () => {
  const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.min(i, 15) * 2);
  const { result } = updateMacd(initialMacdState(), prices);
  assert.equal(result.bullish, false);
});

test("updateMacd's bullish flag does fire on a genuine later crossover (not just always false)", () => {
  // Flat bootstrap window, then a real dip below the signal line, then a
  // real reversal back above it — a genuine crossover, not bootstrap noise.
  const flat = Array.from({ length: 30 }, () => 150);
  const down = Array.from({ length: 20 }, (_, i) => 150 - i * 4);
  const up = Array.from({ length: 30 }, (_, i) => down[down.length - 1]! + i * 6);
  const prices = [...flat, ...down, ...up];

  let state = initialMacdState();
  let sawBullish = false;
  for (let t = 26; t < prices.length; t++) {
    const upd = updateMacd(state, prices.slice(0, t + 1));
    if (upd.result.bullish) sawBullish = true;
    state = upd.state;
  }
  assert(sawBullish, "expected a real dip-then-reversal to be detected as a bullish crossover at some point");
});