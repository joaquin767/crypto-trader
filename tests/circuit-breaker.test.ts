import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCircuitBreakerState, checkEquityBreakers, recordTradeOutcome,
  checkConsecutiveLosses, checkSlippage, DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
} from "../src/risk/circuit-breaker.ts";

const cfg: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG;
const NOW = Date.parse("2026-09-07T12:00:00.000Z");

test("createCircuitBreakerState seeds day/peak equity from the initial value", () => {
  const state = createCircuitBreakerState(1000, NOW);
  assert.equal(state.dayStartEquity, 1000);
  assert.equal(state.peakEquity, 1000);
  assert.equal(state.dayStartUtcDate, "2026-09-07");
  assert.equal(state.consecutiveLosses, 0);
});

test("checkEquityBreakers does not trip when equity is flat", () => {
  const state = createCircuitBreakerState(1000, NOW);
  const { trip } = checkEquityBreakers(state, cfg, 1000, 1000, NOW);
  assert.equal(trip, null);
});

test("checkEquityBreakers trips dailyLoss at the configured threshold, not before", () => {
  const state = createCircuitBreakerState(1000, NOW);
  // 9% loss — under the 10% default threshold, must not trip.
  const under = checkEquityBreakers(state, cfg, 910, 1000, NOW);
  assert.equal(under.trip, null);
  // 10% loss — exactly at threshold, must trip.
  const at = checkEquityBreakers(state, cfg, 900, 1000, NOW);
  assert.equal(at.trip?.trigger, "dailyLoss");
});

test("checkEquityBreakers computes daily loss against maxCapitalUsd, not current equity", () => {
  // A user with $1000 maxCapitalUsd but only $200 currently deployed — a $50
  // loss is 5% of maxCapitalUsd, not 25% of the smaller "current" figure.
  const state = createCircuitBreakerState(1000, NOW);
  const { trip } = checkEquityBreakers(state, cfg, 950, 1000, NOW);
  assert.equal(trip, null, "5% of maxCapitalUsd must not trip the 10% default");
});

test("checkEquityBreakers dailyLoss resets on UTC day rollover", () => {
  let state = createCircuitBreakerState(1000, NOW);
  // Lose 9% today — no trip yet.
  ({ state } = checkEquityBreakers(state, cfg, 910, 1000, NOW));
  // Next UTC day, still at 910 — basis resets to 910, so this is a 0% "daily" loss.
  const nextDay = NOW + 24 * 60 * 60 * 1000;
  const result = checkEquityBreakers(state, cfg, 910, 1000, nextDay);
  assert.equal(result.trip, null);
  assert.equal(result.state.dayStartEquity, 910);
  assert.equal(result.state.dayStartUtcDate, "2026-09-08");
});

test("checkEquityBreakers trips drawdown from peak, not from the day's start", () => {
  let state = createCircuitBreakerState(1000, NOW);
  // Equity climbs to a new peak of 1300.
  ({ state } = checkEquityBreakers(state, cfg, 1300, 2000, NOW));
  assert.equal(state.peakEquity, 1300);
  // Drop to 1040: that's a 20% drawdown from the 1300 peak — must trip, even
  // though it's still above the original 1000 starting value.
  const result = checkEquityBreakers(state, cfg, 1040, 2000, NOW);
  assert.equal(result.trip?.trigger, "drawdown");
});

test("checkEquityBreakers respects `false` to disable a trigger", () => {
  // A total loss would trip both dailyLoss AND drawdown at default thresholds —
  // disable both explicitly to isolate that `false` actually suppresses them,
  // rather than one trigger masking whether the other was really checked.
  const disabled: CircuitBreakerConfig = { ...cfg, maxDailyLossPercent: false, maxDrawdownHaltPercent: false };
  const state = createCircuitBreakerState(1000, NOW);
  const { trip } = checkEquityBreakers(state, disabled, 0, 1000, NOW); // 100% loss
  assert.equal(trip, null, "false must disable the trigger even for a total loss");
});

test("recordTradeOutcome increments on a loss, resets on a win", () => {
  let state = createCircuitBreakerState(1000, NOW);
  state = recordTradeOutcome(state, -10);
  state = recordTradeOutcome(state, -5);
  assert.equal(state.consecutiveLosses, 2);
  state = recordTradeOutcome(state, 20);
  assert.equal(state.consecutiveLosses, 0, "a win must reset the streak, not just fail to increment it");
});

test("checkConsecutiveLosses trips at the configured count", () => {
  let state = createCircuitBreakerState(1000, NOW);
  for (let i = 0; i < 4; i++) state = recordTradeOutcome(state, -1);
  assert.equal(checkConsecutiveLosses(state, cfg, NOW), null, "4 losses must not trip the default limit of 5");
  state = recordTradeOutcome(state, -1);
  assert.equal(checkConsecutiveLosses(state, cfg, NOW)?.trigger, "consecutiveLosses");
});

test("checkSlippage is scoped to one symbol and never global", () => {
  const trip = checkSlippage(cfg, "SOL/USDT", 100, 105, NOW); // 5% > 2% default
  assert.equal(trip?.trigger, "slippage");
  assert.equal(trip?.symbol, "SOL/USDT");
});

test("checkSlippage does not trip within the threshold", () => {
  const trip = checkSlippage(cfg, "SOL/USDT", 100, 101, NOW); // 1% < 2%
  assert.equal(trip, null);
});

test("checkSlippage respects `false` to disable", () => {
  const disabled: CircuitBreakerConfig = { ...cfg, maxSlippagePercent: false };
  const trip = checkSlippage(disabled, "SOL/USDT", 100, 200, NOW); // 100% slip
  assert.equal(trip, null);
});
