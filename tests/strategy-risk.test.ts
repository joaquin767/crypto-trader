import { test } from "node:test";
import assert from "node:assert/strict";
import { calcPositionSize, calcMaxDrawdown, calcSharpe, calcWinRate, calcProfitFactor } from "../src/strategy/risk.ts";
import { empty } from "../src/portfolio.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  exchange: "binance", apiKey: "a", apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

// Regression coverage for spec §9: sizing is now risk-based (a fixed % of
// maxCapitalUsd at stake if the stop is hit), not confidence-scaled. A
// stable major pair and a volatile micro-cap must converge on comparable
// *risk*, not comparable *notional*.

test("calcPositionSize sizes to riskPerTradePercent of maxCapitalUsd over the stop distance", () => {
  // Defaults: riskPerTradePercent=1%, atrStopMultiplier=2, cashReservePercent=10%.
  // atr=0 → atrPercent=0 → stop distance falls back to config.stopLossPercent (5%).
  // riskUsd = 1000 * 0.01 = 10; positionUsd = 10 / (5/100) = 200.
  const size = calcPositionSize(empty(), config, 0, 40000);
  assert.equal(size, 200);
});

test("calcPositionSize shrinks for a symbol whose ATR implies a wider stop than stopLossPercent", () => {
  // price=100, atr=10 → atrPercent=10%; ×atrStopMultiplier(2) = 20% > stopLossPercent(5%)
  // → stop distance is 20%, not 5%. riskUsd=10 → positionUsd = 10 / (20/100) = 50.
  const size = calcPositionSize(empty(), config, 10, 100);
  assert.equal(size, 50);
});

test("calcPositionSize converges volatile and stable symbols on comparable risk, not comparable notional", () => {
  const stableSize = calcPositionSize(empty(), config, 0, 40000); // stop = 5% (configured)
  const volatileSize = calcPositionSize(empty(), config, 20, 100); // atrPercent 20% × 2 = 40% stop
  // Same $ risk (1% of maxCapitalUsd = $10) in both cases, at different stop
  // distances — the volatile symbol's smaller position × its wider stop
  // distance should risk the same dollar amount as the stable symbol's
  // larger position × its tighter stop.
  const stableRiskUsd = stableSize * 0.05;
  const volatileRiskUsd = volatileSize * 0.40;
  assert(Math.abs(stableRiskUsd - volatileRiskUsd) < 0.01);
  assert(volatileSize < stableSize, "the more volatile symbol must get a smaller position");
});

test("calcPositionSize respects maxPositionSizeUsd cap", () => {
  const richPortfolio = { ...empty(), cashUsd: 100000 };
  const richConfig: Config = { ...config, maxCapitalUsd: 100000, stopLossPercent: 0.1 }; // tiny stop → huge implied size
  const size = calcPositionSize(richPortfolio, richConfig, 0, 40000);
  assert.equal(size, richConfig.maxPositionSizeUsd);
});

test("calcPositionSize respects available cash (minus reserve) as a hard cap", () => {
  const poorPortfolio = { ...empty(), cashUsd: 50 };
  const size = calcPositionSize(poorPortfolio, config, 0, 40000);
  assert.equal(size, 45); // 50 * (1 - 10%)
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