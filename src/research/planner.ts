// Planner — specs/daily-catalyst-manual-trading.md §5.5.
//
// Pure throughout: no I/O, no clock reads (decisionTime/dateUtc are inputs). Implements the
// normative sizing algorithm, rounding, check order and price levels verbatim (see the
// doc-comments next to each step below, which quote the spec section they implement).
//
// Spec gap resolved here (flagged in the phase report): §5.5's `PlannerConfig` interface, as
// transcribed, has no `maxOpenManualTrades` field, yet the normative "open-trade accounting"
// prose and AC-14/AC-14a both require planTrade to compare `openTradeCount` against exactly
// that config value, and `planTrade`'s own parameter list has no separate slot for it either.
// Rather than inventing a 12th positional parameter (which would deviate further from the
// spec's literal signature), `maxOpenManualTrades` is added as a field on the `cfg` bag that
// `planTrade` already receives — the smallest change that makes the function well-defined.

import type { Condition, RuleDefinition, RuleOutcome } from "./rules.ts";
import type { FeatureVector, SourceSnapshot } from "./types.ts";

export interface PlannerConfig {
  maxCapitalUsd: number;
  riskPerTradePercent: number; // existing config field, src/config.ts:42
  maxLeverage: number; // integer 1..5; global ceiling (§5.11)
  liveLadderCap: number; // integer 1..maxLeverage, default 2; applies to a rule's first 20 live trades (§8.3)
  marginBudgetPercent: number; // % of maxCapitalUsd usable as margin for one trade, (0, 100]
  maintenanceMarginRate: number; // default 0.005, used only for the planning estimate
  minLiqToStopRatio: number; // default 2.0
  roundTripFeePercent: number; // default 0.11 (taker 0.055% x 2)
  /** See file header: not in the spec's literal PlannerConfig transcription, but required by
   *  the normative open-trade accounting prose and AC-14/AC-14a. */
  maxOpenManualTrades: number;
}

export type TradePlan =
  | {
      kind: "plan";
      planId: string;
      ruleId: string;
      ruleHash: string;
      origin: "rules-file" | "ai-analyst";
      symbol: string;
      side: "long" | "short";
      referencePrice: number;
      stopPrice: number;
      targetPrice: number;
      expiresAt: number;
      quantity: number;
      notionalUsd: number;
      riskUsd: number;
      leverage: number;
      marginUsd: number;
      estLiquidationPrice: number;
      liqToStopRatio: number;
      estRoundTripFeeUsd: number;
      venueIntent: "paper" | "live"; // "live" only if rule.status === "paper-passed" (§8)
    }
  | {
      kind: "rejected";
      ruleId: string;
      origin: "rules-file" | "ai-analyst";
      symbol: string;
      reason: "liq_too_close" | "size_below_min" | "atr_missing" | "breaker_tripped" | "max_open_trades" | "instrument_missing";
    };

/** Pure. Returns 1 unless rule.status === "paper-passed";
 *  then liveLadderCap if liveClosedTradesForRule < 20 or ladderResetByBreaker, else maxLeverage. */
export function effectiveMaxLeverage(
  rule: RuleDefinition,
  cfg: PlannerConfig,
  liveClosedTradesForRule: number,
  ladderResetByBreaker: boolean,
): number {
  if (rule.status !== "paper-passed") return 1;
  if (liveClosedTradesForRule < 20 || ladderResetByBreaker) return cfg.liveLadderCap;
  return cfg.maxLeverage;
}

/** Exchange order-size filters for one symbol (Bybit lotSizeFilter). */
export interface InstrumentFilter {
  minOrderQty: number;
  qtyStep: number;
  minNotionalValue: number;
}

/** Pure. Reads the "bybit-instruments" snapshot (§5.3b); a symbol absent or with non-positive
 *  values maps to null. This source is never staleness-filtered (it isn't a feature — see
 *  bybit-instruments.ts); an unavailable/invalid snapshot has zero rows by construction
 *  (src/research/sources/common.ts), so it naturally yields null for every symbol. */
export function instrumentFilters(
  snapshots: readonly SourceSnapshot[],
  symbols: readonly string[],
): Record<string, InstrumentFilter | null> {
  const snap = snapshots.find((s) => s.sourceId === "bybit-instruments");
  const result: Record<string, InstrumentFilter | null> = {};
  for (const symbol of symbols) {
    const minOrderQty = Number(snap?.rows.find((r) => r.key === symbol && r.field === "minOrderQty")?.value);
    const qtyStep = Number(snap?.rows.find((r) => r.key === symbol && r.field === "qtyStep")?.value);
    const minNotionalValue = Number(snap?.rows.find((r) => r.key === symbol && r.field === "minNotionalValue")?.value);
    const valid =
      Number.isFinite(minOrderQty) && minOrderQty > 0 &&
      Number.isFinite(qtyStep) && qtyStep > 0 &&
      Number.isFinite(minNotionalValue) && minNotionalValue > 0;
    result[symbol] = valid ? { minOrderQty, qtyStep, minNotionalValue } : null;
  }
  return result;
}

/** Linear isolated estimate: long entry×(1 − 1/L + mmr), short entry×(1 + 1/L − mmr). */
export function estimateLiquidationPrice(entry: number, side: "long" | "short", leverage: number, mmr: number): number {
  return side === "long" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

const HOUR_MS = 60 * 60 * 1000;
const EXPIRES_AFTER_MS = 12 * HOUR_MS; // A2

function featureValue(fv: FeatureVector, feature: "close" | "atr14d"): number | null {
  const f = fv.features[feature];
  return f.kind === "value" ? f.value : null;
}

/** Pure. planId = `${dateUtc}:${ruleId}:${symbol}`. Uses effectiveMaxLeverage(...) as the
 *  leverage cap. decisionTime is the effective decision time (§5.12).
 *  instrument null → rejected "instrument_missing".
 *
 *  Check order (first match decides, §5.5): breaker_tripped → max_open_trades →
 *  instrument_missing → atr_missing (also when close is missing) → sizing → liq_too_close →
 *  size_below_min. */
export function planTrade(
  outcome: Extract<RuleOutcome, { result: "triggered" }>,
  rule: RuleDefinition,
  fv: FeatureVector,
  cfg: PlannerConfig,
  openTradeCount: number,
  breakerTripped: boolean,
  dateUtc: string,
  liveClosedTradesForRule: number,
  ladderResetByBreaker: boolean,
  instrument: InstrumentFilter | null,
  decisionTime: number,
): TradePlan {
  const rejected = (reason: Extract<TradePlan, { kind: "rejected" }>["reason"]): TradePlan => ({
    kind: "rejected",
    ruleId: outcome.ruleId,
    origin: rule.origin,
    symbol: outcome.symbol,
    reason,
  });

  if (breakerTripped) return rejected("breaker_tripped");
  if (openTradeCount >= cfg.maxOpenManualTrades) return rejected("max_open_trades");
  if (instrument === null) return rejected("instrument_missing");

  const referencePrice = featureValue(fv, "close");
  const atr = featureValue(fv, "atr14d");
  if (referencePrice === null || atr === null) return rejected("atr_missing");

  const effMaxLev = effectiveMaxLeverage(rule, cfg, liveClosedTradesForRule, ladderResetByBreaker);
  const marginBudget = (cfg.maxCapitalUsd * cfg.marginBudgetPercent) / 100;
  const stopDistance = atr * rule.stopAtrMultiple;

  // ── Sizing algorithm (normative, §5.5) ────────────────────────────────────────────────────
  let riskUsd = (cfg.maxCapitalUsd * cfg.riskPerTradePercent) / 100;
  let quantity = riskUsd / stopDistance;
  let notionalUsd = quantity * referencePrice;
  let leverage = Math.max(1, Math.ceil(notionalUsd / marginBudget));

  if (leverage > effMaxLev) {
    leverage = effMaxLev;
    quantity = (marginBudget * leverage) / referencePrice;
    notionalUsd = quantity * referencePrice;
    riskUsd = quantity * stopDistance;
  }

  let estLiquidationPrice = estimateLiquidationPrice(referencePrice, rule.side, leverage, cfg.maintenanceMarginRate);
  let liqToStopRatio = Math.abs(referencePrice - estLiquidationPrice) / stopDistance;

  while (liqToStopRatio < cfg.minLiqToStopRatio && leverage > 1) {
    leverage -= 1;
    quantity = (marginBudget * leverage) / referencePrice;
    notionalUsd = quantity * referencePrice;
    riskUsd = quantity * stopDistance;
    estLiquidationPrice = estimateLiquidationPrice(referencePrice, rule.side, leverage, cfg.maintenanceMarginRate);
    liqToStopRatio = Math.abs(referencePrice - estLiquidationPrice) / stopDistance;
  }

  if (liqToStopRatio < cfg.minLiqToStopRatio) return rejected("liq_too_close");

  // Rounding (normative, floating-point safe): quantity rounds DOWN to a multiple of qtyStep.
  const roundedQuantity = Math.floor(quantity / instrument.qtyStep + 1e-9) * instrument.qtyStep;
  const roundedNotional = roundedQuantity * referencePrice;
  if (roundedQuantity < instrument.minOrderQty || roundedNotional < instrument.minNotionalValue) {
    return rejected("size_below_min");
  }

  quantity = roundedQuantity;
  notionalUsd = roundedNotional;
  riskUsd = quantity * stopDistance; // recomputed from the rounded quantity; rounding never increases risk
  const marginUsd = notionalUsd / leverage;
  const estRoundTripFeeUsd = (notionalUsd * cfg.roundTripFeePercent) / 100;

  // ── Price levels (normative, §5.5) ────────────────────────────────────────────────────────
  const stopPrice = rule.side === "long" ? referencePrice - stopDistance : referencePrice + stopDistance;
  const targetPrice = rule.side === "long"
    ? referencePrice + stopDistance * rule.targetRMultiple
    : referencePrice - stopDistance * rule.targetRMultiple;
  const venueIntent: "paper" | "live" = rule.status === "paper-passed" ? "live" : "paper";

  return {
    kind: "plan",
    planId: `${dateUtc}:${outcome.ruleId}:${outcome.symbol}`,
    ruleId: outcome.ruleId,
    ruleHash: outcome.ruleHash,
    origin: rule.origin,
    symbol: outcome.symbol,
    side: rule.side,
    referencePrice,
    stopPrice,
    targetPrice,
    expiresAt: decisionTime + EXPIRES_AFTER_MS,
    quantity,
    notionalUsd,
    riskUsd,
    leverage,
    marginUsd,
    estLiquidationPrice,
    liqToStopRatio,
    estRoundTripFeeUsd,
    venueIntent,
  };
}

// Re-exported so callers building AI-origin synthesized outcomes (§5.13) don't need a second
// import path for the Condition type used by RuleDefinition.
export type { Condition };
