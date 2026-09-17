// Planner tests — specs/daily-catalyst-manual-trading.md §5.5, AC-11..15a.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RuleDefinition, RuleOutcome } from "../src/research/rules.ts";
import { ruleHash } from "../src/research/rules.ts";
import type { InstrumentFilter, PlannerConfig } from "../src/research/planner.ts";
import { effectiveMaxLeverage, estimateLiquidationPrice, instrumentFilters, planTrade } from "../src/research/planner.ts";
import type { FeatureValue, FeatureVector, SourceSnapshot } from "../src/research/types.ts";

function closeAndAtr(close: number, atr14d: number): Record<string, FeatureValue> {
  const missing = (feature: string): FeatureValue => ({ kind: "missing", reason: `unused in this test: ${feature}`, sourceId: "bybit-klines-1d" });
  const base: Record<string, FeatureValue> = {
    close: { kind: "value", value: close, availableAt: 0, sourceId: "bybit-klines-1d" },
    return1d: missing("return1d"), return7d: missing("return7d"),
    atr14d: { kind: "value", value: atr14d, availableAt: 0, sourceId: "bybit-klines-1d" },
    realizedVol7d: missing("realizedVol7d"),
    fundingRate8hAvg3d: missing("fundingRate8hAvg3d"), fundingRatePercentile90d: missing("fundingRatePercentile90d"),
    oiChange3dPct: missing("oiChange3dPct"),
    btcEtfNetFlowUsd1d: missing("btcEtfNetFlowUsd1d"), btcEtfNetFlowUsd5d: missing("btcEtfNetFlowUsd5d"),
    ethEtfNetFlowUsd1d: missing("ethEtfNetFlowUsd1d"),
    stablecoinSupplyChange7dPct: missing("stablecoinSupplyChange7dPct"), fearGreed: missing("fearGreed"),
    hoursToNextFomc: missing("hoursToNextFomc"), hoursToNextCpi: missing("hoursToNextCpi"),
    daysToNextUnlock: missing("daysToNextUnlock"), nextUnlockPctOfFloat: missing("nextUnlockPctOfFloat"),
  };
  return base;
}

function fv(symbol: string, close: number, atr14d: number): FeatureVector {
  return { symbol, decisionTime: 0, features: closeAndAtr(close, atr14d) as FeatureVector["features"] };
}

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "test-rule", version: 1, description: "d", evidence: ["X1"], status: "paper-passed",
    symbols: ["BTC/USDT"], side: "long",
    entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
    stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
    ...overrides,
  };
}

function triggeredOutcome(r: RuleDefinition, symbol: string): Extract<RuleOutcome, { result: "triggered" }> {
  return { ruleId: r.id, ruleHash: ruleHash(r), symbol, result: "triggered", evidence: {} };
}

const CFG: PlannerConfig = {
  maxCapitalUsd: 100,
  riskPerTradePercent: 1,
  maxLeverage: 5,
  liveLadderCap: 2,
  marginBudgetPercent: 25,
  maintenanceMarginRate: 0.005,
  minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11,
  maxOpenManualTrades: 3,
};

const INSTRUMENT: InstrumentFilter = { minOrderQty: 0.0001, qtyStep: 0.0001, minNotionalValue: 5 };

function plan(r: RuleDefinition, symbol: string, atr = 1000, close = 60000, instrument: InstrumentFilter | null = INSTRUMENT, cfg = CFG) {
  const outcome = triggeredOutcome(r, symbol);
  return planTrade(outcome, r, fv(symbol, close, atr), cfg, 0, false, "2026-09-16", 0, false, instrument, Date.UTC(2026, 8, 16, 0, 15));
}

// ── AC-15 estimateLiquidationPrice ─────────────────────────────────────────────────────────

test("AC-15: estimateLiquidationPrice long/short", () => {
  assert.ok(Math.abs(estimateLiquidationPrice(100, "long", 2, 0.005) - 50.5) < 1e-9);
  assert.ok(Math.abs(estimateLiquidationPrice(100, "short", 2, 0.005) - 149.5) < 1e-9);
});

// ── AC-15a effectiveMaxLeverage ─────────────────────────────────────────────────────────────

test("AC-15a: effectiveMaxLeverage per status/ladder/breaker-reset", () => {
  const cfg = { ...CFG, maxLeverage: 5, liveLadderCap: 2 };
  assert.equal(effectiveMaxLeverage(rule({ status: "holdout-passed" }), cfg, 0, false), 1);
  assert.equal(effectiveMaxLeverage(rule({ status: "paper-passed" }), cfg, 19, false), 2);
  assert.equal(effectiveMaxLeverage(rule({ status: "paper-passed" }), cfg, 20, false), 5);
  assert.equal(effectiveMaxLeverage(rule({ status: "paper-passed" }), cfg, 20, true), 2);
});

// ── AC-11/11a/11b sizing ─────────────────────────────────────────────────────────────────────

test("AC-11: the worked sizing example", () => {
  const r = rule({ status: "paper-passed" });
  const result = plan(r, "BTC/USDT");
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.ok(Math.abs(result.riskUsd - 1) < 1e-9);
  assert.ok(Math.abs(result.quantity - 0.0005) < 1e-9);
  assert.ok(Math.abs(result.notionalUsd - 30) < 1e-9);
  assert.equal(result.leverage, 2);
  assert.ok(Math.abs(result.marginUsd - 15) < 1e-9);
  assert.ok(Math.abs(result.stopPrice - 58000) < 1e-9);
  assert.ok(Math.abs(result.targetPrice - (60000 + 2000 * r.targetRMultiple)) < 1e-9);
});

test("AC-11a: qtyStep=0.001/minOrderQty=0.001 rounds to below minOrderQty -> size_below_min", () => {
  const r = rule({ status: "paper-passed" });
  const result = plan(r, "BTC/USDT", 1000, 60000, { minOrderQty: 0.001, qtyStep: 0.001, minNotionalValue: 5 });
  assert.deepEqual(result, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "size_below_min" });
});

test("AC-11a: qtyStep=0.0003/minOrderQty=0.0003 rounds down cleanly", () => {
  const r = rule({ status: "paper-passed" });
  const result = plan(r, "BTC/USDT", 1000, 60000, { minOrderQty: 0.0003, qtyStep: 0.0003, minNotionalValue: 5 });
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.ok(Math.abs(result.quantity - 0.0003) < 1e-9);
  assert.ok(Math.abs(result.riskUsd - 0.6) < 1e-9);
  assert.ok(Math.abs(result.notionalUsd - 18) < 1e-9);
  assert.ok(Math.abs(result.marginUsd - 9) < 1e-9);
});

test("AC-11b: instrument null -> instrument_missing", () => {
  const r = rule({ status: "paper-passed" });
  const result = plan(r, "BTC/USDT", 1000, 60000, null);
  assert.deepEqual(result, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "instrument_missing" });
});

test("AC-11b: missing atr14d or close -> atr_missing", () => {
  const r = rule({ status: "paper-passed" });
  const outcome = triggeredOutcome(r, "BTC/USDT");
  const featuresNoAtr = closeAndAtr(60000, 1000);
  featuresNoAtr["atr14d"] = { kind: "missing", reason: "x", sourceId: "bybit-klines-1d" };
  const fvNoAtr: FeatureVector = { symbol: "BTC/USDT", decisionTime: 0, features: featuresNoAtr as FeatureVector["features"] };
  const result = planTrade(outcome, r, fvNoAtr, CFG, 0, false, "2026-09-16", 0, false, INSTRUMENT, 0);
  assert.deepEqual(result, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "atr_missing" });

  const featuresNoClose = closeAndAtr(60000, 1000);
  featuresNoClose["close"] = { kind: "missing", reason: "x", sourceId: "bybit-klines-1d" };
  const fvNoClose: FeatureVector = { symbol: "BTC/USDT", decisionTime: 0, features: featuresNoClose as FeatureVector["features"] };
  const result2 = planTrade(outcome, r, fvNoClose, CFG, 0, false, "2026-09-16", 0, false, INSTRUMENT, 0);
  assert.deepEqual(result2, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "atr_missing" });
});

// ── AC-12 ────────────────────────────────────────────────────────────────────────────────────

test("AC-12: holdout-passed status forces leverage 1 and venueIntent paper", () => {
  const r = rule({ status: "holdout-passed" });
  const result = plan(r, "BTC/USDT");
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.equal(result.leverage, 1);
  assert.equal(result.venueIntent, "paper");
});

// ── AC-13 liq_too_close ─────────────────────────────────────────────────────────────────────

test("AC-13: every leverage down to 1 still fails minLiqToStopRatio -> liq_too_close", () => {
  // An enormous minLiqToStopRatio requirement can never be satisfied at any leverage.
  const cfg: PlannerConfig = { ...CFG, minLiqToStopRatio: 1_000_000 };
  const r = rule({ status: "paper-passed" });
  const result = plan(r, "BTC/USDT", 1000, 60000, INSTRUMENT, cfg);
  assert.deepEqual(result, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "liq_too_close" });
});

// ── AC-14 breaker / max open trades ─────────────────────────────────────────────────────────

test("AC-14: breakerTripped=true rejects every plan", () => {
  const r = rule({ status: "paper-passed" });
  const outcome = triggeredOutcome(r, "BTC/USDT");
  const result = planTrade(outcome, r, fv("BTC/USDT", 60000, 1000), CFG, 0, true, "2026-09-16", 0, false, INSTRUMENT, 0);
  assert.deepEqual(result, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "breaker_tripped" });
});

test("AC-14: openTradeCount >= maxOpenManualTrades rejects with max_open_trades", () => {
  const r = rule({ status: "paper-passed" });
  const outcome = triggeredOutcome(r, "BTC/USDT");
  const result = planTrade(outcome, r, fv("BTC/USDT", 60000, 1000), CFG, 3, false, "2026-09-16", 0, false, INSTRUMENT, 0);
  assert.deepEqual(result, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "max_open_trades" });
});

test("check order: breaker_tripped beats max_open_trades beats instrument_missing beats atr_missing", () => {
  const r = rule({ status: "paper-passed" });
  const outcome = triggeredOutcome(r, "BTC/USDT");
  // breaker tripped AND over the open-trade cap AND no instrument AND missing atr — only
  // breaker_tripped should surface.
  const featuresNoAtr = closeAndAtr(60000, 1000);
  featuresNoAtr["atr14d"] = { kind: "missing", reason: "x", sourceId: "bybit-klines-1d" };
  const fvNoAtr: FeatureVector = { symbol: "BTC/USDT", decisionTime: 0, features: featuresNoAtr as FeatureVector["features"] };
  const result = planTrade(outcome, r, fvNoAtr, CFG, 3, true, "2026-09-16", 0, false, null, 0);
  assert.deepEqual(result, { kind: "rejected", ruleId: r.id, origin: "rules-file", symbol: "BTC/USDT", reason: "breaker_tripped" });
});

// ── instrumentFilters ────────────────────────────────────────────────────────────────────────

test("instrumentFilters: reads minOrderQty/qtyStep/minNotionalValue rows, null when absent or non-positive", () => {
  const snap: SourceSnapshot = {
    sourceId: "bybit-instruments", fetchedAt: 0, status: "ok", statusDetail: "", sha256: "x",
    rows: [
      { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "minOrderQty", value: 0.001 },
      { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "qtyStep", value: 0.001 },
      { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "minNotionalValue", value: 5 },
      { key: "ETH/USDT", observedFor: 0, availableAt: 0, field: "minOrderQty", value: 0 }, // non-positive -> null
      { key: "ETH/USDT", observedFor: 0, availableAt: 0, field: "qtyStep", value: 0.01 },
      { key: "ETH/USDT", observedFor: 0, availableAt: 0, field: "minNotionalValue", value: 5 },
    ],
  };
  const result = instrumentFilters([snap], ["BTC/USDT", "ETH/USDT", "SOL/USDT"]);
  assert.deepEqual(result["BTC/USDT"], { minOrderQty: 0.001, qtyStep: 0.001, minNotionalValue: 5 });
  assert.equal(result["ETH/USDT"], null);
  assert.equal(result["SOL/USDT"], null); // absent entirely
});

test("instrumentFilters: an unavailable snapshot (zero rows) yields null for every symbol", () => {
  const snap: SourceSnapshot = { sourceId: "bybit-instruments", fetchedAt: 0, status: "unavailable", statusDetail: "network error", sha256: "x", rows: [] };
  const result = instrumentFilters([snap], ["BTC/USDT"]);
  assert.equal(result["BTC/USDT"], null);
});

test("instrumentFilters: no bybit-instruments snapshot at all yields null for every symbol", () => {
  const result = instrumentFilters([], ["BTC/USDT"]);
  assert.equal(result["BTC/USDT"], null);
});

// ── price levels: short side ─────────────────────────────────────────────────────────────────

test("price levels: short side mirrors long (stop above, target below)", () => {
  const r = rule({ status: "paper-passed", side: "short" });
  const result = plan(r, "BTC/USDT", 1000, 60000);
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.ok(Math.abs(result.stopPrice - 62000) < 1e-9);
  assert.ok(Math.abs(result.targetPrice - (60000 - 2000 * r.targetRMultiple)) < 1e-9);
  assert.equal(result.side, "short");
});

test("planId format and expiresAt = decisionTime + 12h (A2)", () => {
  const r = rule({ status: "paper-passed" });
  const decisionTime = Date.UTC(2026, 8, 16, 0, 15);
  const outcome = triggeredOutcome(r, "BTC/USDT");
  const result = planTrade(outcome, r, fv("BTC/USDT", 60000, 1000), CFG, 0, false, "2026-09-16", 0, false, INSTRUMENT, decisionTime);
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.equal(result.planId, `2026-09-16:${r.id}:BTC/USDT`);
  assert.equal(result.expiresAt, decisionTime + 12 * 60 * 60 * 1000);
});
