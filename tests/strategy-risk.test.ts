import { test } from "node:test";
import assert from "node:assert/strict";
import { calcPositionSize, calcMaxDrawdown, calcSharpe, calcWinRate, calcProfitFactor } from "../src/strategy/risk.ts";
import { empty } from "../src/portfolio.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  exchange: "binance", apiKey: "a", apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

test("calcPositionSize returns 0 for confidence below 0.5", () => {
  const size = calcPositionSize(0.4, empty(), config);
  assert.equal(size, 0);
});

test("calcPositionSize returns positive size for high confidence", () => {
  const size = calcPositionSize(0.9, empty(), config);
  assert(size > 0);
  assert(size <= config.maxPositionSizeUsd);
});

test("calcPositionSize respects maxPositionSizeUsd cap", () => {
  const richPortfolio = { ...empty(), cashUsd: 100000 };
  const size = calcPositionSize(1.0, richPortfolio, config);
  assert(size <= config.maxPositionSizeUsd);
});

test("calcMaxDrawdown returns 0 for rising values", () => {
  assert.equal(calcMaxDrawdown([100, 110, 120, 130]), 0);
});

test("calcMaxDrawdown returns correct percentage", () => {
  const dd = calcMaxDrawdown([100, 120, 90, 110, 80]);
  // Peak was 120, trough was 80, so drawdown = (120-80)/120 = 33.3%
  assert(Math.abs(dd - 33.3) < 1);
});

test("calcSharpe returns 0 for empty or single return", () => {
  assert.equal(calcSharpe([]), 0);
  assert.equal(calcSharpe([0.01]), 0);
});

test("calcSharpe returns positive for consistent positive returns", () => {
  const sharpe = calcSharpe(Array.from({ length: 20 }, () => 0.01));
  assert(sharpe > 0);
});

test("calcWinRate returns correct percentage", () => {
  assert.equal(calcWinRate([1, 1, -1, 1, -1]), 0.6);
});

test("calcWinRate returns 0 for empty trades", () => {
  assert.equal(calcWinRate([]), 0);
});

test("calcProfitFactor returns Infinity for no losses", () => {
  assert.equal(calcProfitFactor([1, 2, 3]), Infinity);
});

test("calcProfitFactor returns correct ratio", () => {
  // gross profit = 6, gross loss = 3 (abs(-1-1-1)), PF = 2
  assert.equal(calcProfitFactor([3, -1, 3, -1, -1]), 2);
});