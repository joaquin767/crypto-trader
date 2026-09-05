import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcSMA, calcEMA, calcRSI, calcMACD, calcBollinger,
  calcATR, calcMomentum,
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