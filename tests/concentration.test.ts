import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkConcurrentPositionsLimit, calcReturns, calcCorrelation, checkCorrelationLimit,
} from "../src/strategy/concentration.ts";

test("checkConcurrentPositionsLimit is uncapped when disabled", () => {
  assert.equal(checkConcurrentPositionsLimit(50, false).skip, false);
  assert.equal(checkConcurrentPositionsLimit(50, undefined).skip, false);
});

test("checkConcurrentPositionsLimit skips at and above the limit, not below it", () => {
  assert.equal(checkConcurrentPositionsLimit(2, 3).skip, false);
  assert.equal(checkConcurrentPositionsLimit(3, 3).skip, true);
  assert.equal(checkConcurrentPositionsLimit(4, 3).skip, true);
});

test("calcReturns computes period-over-period percent change", () => {
  const returns = calcReturns([100, 110, 99]);
  assert.equal(returns.length, 2);
  assert(Math.abs(returns[0]! - 0.10) < 1e-9);
  assert(Math.abs(returns[1]! - (-0.1)) < 1e-9);
});

test("calcReturns skips a step where the previous price is 0 rather than dividing by zero", () => {
  const returns = calcReturns([0, 10, 20]);
  assert.equal(returns.length, 1); // only the 10→20 step is computable
  assert(Number.isFinite(returns[0]!));
});

test("calcCorrelation is 1 for identical series and returns 0 for too-short input", () => {
  const series = [0.01, -0.02, 0.03, 0.015, -0.01];
  assert(Math.abs(calcCorrelation(series, series) - 1) < 1e-9);
  assert.equal(calcCorrelation([0.01], [0.01]), 0);
});

test("calcCorrelation is near -1 for inverted series", () => {
  const a = [0.01, -0.02, 0.03, 0.015, -0.01];
  const b = a.map(x => -x);
  assert(calcCorrelation(a, b) < -0.99);
});

test("calcCorrelation returns 0 for a zero-variance series (avoids NaN from divide-by-zero)", () => {
  const flat = [0, 0, 0, 0];
  const other = [0.01, -0.02, 0.03, 0.015];
  assert.equal(calcCorrelation(flat, other), 0);
});

test("checkCorrelationLimit skips a candidate highly correlated with an open position", () => {
  const prices = [100, 101, 99, 102, 98, 103];
  const check = checkCorrelationLimit("A/USDT", prices, [{ symbol: "B/USDT", prices }], 0.8);
  assert.equal(check.skip, true);
});

test("checkCorrelationLimit does not skip when correlation is below the threshold", () => {
  const pricesA = [100, 101, 102, 103, 104, 105]; // steadily up
  const pricesB = [100, 99, 101, 98, 102, 97];    // choppy, uncorrelated
  const check = checkCorrelationLimit("A/USDT", pricesA, [{ symbol: "B/USDT", prices: pricesB }], 0.8);
  assert.equal(check.skip, false);
});

test("checkCorrelationLimit ignores the candidate's own symbol in the open-positions list", () => {
  const prices = [100, 101, 99, 102, 98, 103];
  const check = checkCorrelationLimit("A/USDT", prices, [{ symbol: "A/USDT", prices }], 0.8);
  assert.equal(check.skip, false, "a symbol must never be compared against itself");
});

test("checkCorrelationLimit is disabled by false/undefined", () => {
  const prices = [100, 101, 99, 102, 98, 103];
  assert.equal(checkCorrelationLimit("A/USDT", prices, [{ symbol: "B/USDT", prices }], false).skip, false);
  assert.equal(checkCorrelationLimit("A/USDT", prices, [{ symbol: "B/USDT", prices }], undefined).skip, false);
});
