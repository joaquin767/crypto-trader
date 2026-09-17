// Persona decision channel — validation/sizing tests. specs/daily-catalyst-manual-trading.md
// §5.15, §6.9 AC-98..AC-106, AC-111, AC-113, AC-114, AC-120.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RuleDefinition } from "../src/research/rules.ts";
import { ruleHash } from "../src/research/rules.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "../src/research/planner.ts";
import { planTrade } from "../src/research/planner.ts";
import type { FeatureValue, FeatureVector } from "../src/research/types.ts";
import type { DailyReport } from "../src/research/report.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import type { PersonaConfig } from "../src/config.ts";
import type {
  DailyDecisionInput, DecisionContext, ManageContext, ManageInput, PersonaIdea, ReviewContext,
  ReviewInput,
} from "../src/decision/types.ts";
import {
  buildOwnerProtocol, personaIdeaToRule, planFromChoice, reportPlanToPersonaRule, validateDecision,
  validateManage, validateReview, withPersonaProvenance,
} from "../src/decision/decide.ts";

type PlanRow = Extract<TradePlan, { kind: "plan" }>;

function closeAndAtr(close: number, atr14d: number): Record<string, FeatureValue> {
  const missing = (feature: string): FeatureValue => ({ kind: "missing", reason: `unused: ${feature}`, sourceId: "bybit-klines-1d" });
  return {
    close: { kind: "value", value: close, availableAt: 0, sourceId: "bybit-klines-1d" },
    return1d: missing("return1d"), return7d: missing("return7d"),
    atr14d: { kind: "value", value: atr14d, availableAt: 0, sourceId: "bybit-klines-1d" },
    realizedVol7d: missing("realizedVol7d"),
    fundingRate8hAvg3d: { kind: "value", value: 0.0002, availableAt: 0, sourceId: "bybit-funding" },
    fundingRatePercentile90d: missing("fundingRatePercentile90d"),
    oiChange3dPct: missing("oiChange3dPct"),
    btcEtfNetFlowUsd1d: missing("btcEtfNetFlowUsd1d"), btcEtfNetFlowUsd5d: missing("btcEtfNetFlowUsd5d"),
    ethEtfNetFlowUsd1d: missing("ethEtfNetFlowUsd1d"),
    stablecoinSupplyChange7dPct: missing("stablecoinSupplyChange7dPct"), fearGreed: missing("fearGreed"),
    hoursToNextFomc: missing("hoursToNextFomc"), hoursToNextCpi: missing("hoursToNextCpi"),
    daysToNextUnlock: missing("daysToNextUnlock"), nextUnlockPctOfFloat: missing("nextUnlockPctOfFloat"),
  };
}

function fv(symbol: string, close: number, atr14d: number): FeatureVector {
  return { symbol, decisionTime: 0, features: closeAndAtr(close, atr14d) as FeatureVector["features"] };
}

const DATE = "2026-09-18";
const DECISION_TIME = Date.parse(`${DATE}T00:15:00Z`);
const NOW = DECISION_TIME + 60 * 60 * 1000; // 1h later, well inside every window used below
const FV_BTC = fv("BTC/USDT", 60000, 1000);
const INSTRUMENT: InstrumentFilter = { minOrderQty: 0.0001, qtyStep: 0.0001, minNotionalValue: 5 };
const CFG: PlannerConfig = {
  maxCapitalUsd: 100, riskPerTradePercent: 1, maxLeverage: 5, liveLadderCap: 2,
  marginBudgetPercent: 25, maintenanceMarginRate: 0.005, minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11, maxOpenManualTrades: 3,
};
const SKILL_HASH = "a".repeat(64);
const PERSONA_CFG: PersonaConfig = {
  executionWindowMs: 21_600_000, maxEntryGapAtr: 0.25, channelStatus: "experimental",
  passedSkillHash: null, ownerTimeZone: "America/Argentina/Buenos_Aires",
  decisionsRoot: "data/decisions", skillRoot: ".claude/skills/crypto-fundamental-analyst",
};

function sourceRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "etf-flow-momentum", version: 1, description: "d", evidence: ["X1"], status: "experimental",
    symbols: ["BTC/USDT"], side: "long",
    entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
    stopAtrMultiple: 2, targetRMultiple: 2, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
    ...overrides,
  };
}

function makeSourcePlan(rule: RuleDefinition): PlanRow {
  const outcome = { ruleId: rule.id, ruleHash: ruleHash(rule), symbol: "BTC/USDT", result: "triggered" as const, evidence: {} };
  const plan = planTrade(outcome, rule, FV_BTC, CFG, 0, false, DATE, 0, false, INSTRUMENT, DECISION_TIME);
  assert.equal(plan.kind, "plan");
  return plan as PlanRow;
}

function makeReport(plans: TradePlan[]): DailyReport {
  return {
    schemaVersion: 1, dateUtc: DATE, decisionTime: DECISION_TIME, generatedAt: DECISION_TIME,
    ruleSetSha256: "deadbeef", sources: [], completeness: "complete",
    breaker: { tripped: false, trigger: null, details: "" },
    outcomes: [], plans, openTradeThesis: [],
    aiAnalyst: {
      status: "disabled", reason: "", model: null, provider: null, servedByModel: null, promptVersionHash: null,
      costUsd: 0, monthToDateUsd: 0, listCostUsd: 0, regimeSummary: null,
      assessments: [], plans: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], rejected: [],
    },
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };
}

function makeCtx(overrides: Partial<DecisionContext> & { plan?: PlanRow; rule?: RuleDefinition } = {}): DecisionContext {
  const rule = overrides.rule ?? sourceRule();
  const plan = overrides.plan ?? makeSourcePlan(rule);
  return {
    dateUtc: DATE,
    report: makeReport([plan]),
    reportPath: "reports/2026-09-18.json",
    reportSha256: "abc123",
    features: [FV_BTC],
    configSymbols: ["BTC/USDT", "ETH/USDT"],
    plannerConfig: CFG,
    personaCfg: PERSONA_CFG,
    skillHash: SKILL_HASH,
    ruleSet: { schemaVersion: 1, rules: [rule] },
    aiRules: {},
    journal: [],
    breaker: { tripped: false, trigger: null, details: "" },
    liveClosedTradesForPersona: 0,
    ladderResetByBreaker: false,
    instruments: { "BTC/USDT": INSTRUMENT, "ETH/USDT": INSTRUMENT },
    now: NOW,
    ...overrides,
  };
}

function baseInput(planId: string, overrides: Partial<DailyDecisionInput> = {}): DailyDecisionInput {
  return {
    dateUtc: DATE,
    choice: { kind: "report-plan", planId },
    stances: [{ planId, stance: "support", reasons: ["good setup"] }],
    news: [],
    rationale: "Following the rule plan.",
    ...overrides,
  };
}

// ── AC-98/99: report-plan choice, sizing equality ───────────────────────────────────────────────

test("AC-98: a report-plan choice with a stance for every plan validates ok", () => {
  const rule = sourceRule();
  const plan = makeSourcePlan(rule);
  const ctx = makeCtx({ plan, rule });
  const input = baseInput(plan.planId);
  const validation = validateDecision(input, ctx);
  assert.deepEqual(validation.rejections, []);
  assert.equal(validation.ok, true);
});

test("AC-99: sizing equality — same status on both sides, the persona plan matches P in every sizing field", () => {
  const rule = sourceRule({ status: "experimental" });
  const plan = makeSourcePlan(rule);
  const ctx = makeCtx({ plan, rule });
  const input = baseInput(plan.planId);
  assert.equal(validateDecision(input, ctx).ok, true);

  const attempt = planFromChoice(input.choice as Extract<DailyDecisionInput["choice"], { kind: "report-plan" }>, ctx);
  assert.ok(attempt && attempt.plan.kind === "plan");
  const personaPlan = attempt.plan as PlanRow;

  for (const field of [
    "symbol", "side", "referencePrice", "stopPrice", "targetPrice", "expiresAt", "quantity",
    "notionalUsd", "riskUsd", "leverage", "marginUsd", "estLiquidationPrice", "liqToStopRatio",
    "estRoundTripFeeUsd", "venueIntent", "maxHoldDays",
  ] as const) {
    const a = personaPlan[field];
    const b = plan[field];
    if (typeof a === "number" && typeof b === "number") {
      assert.ok(Math.abs(a - b) < 1e-9, `${field}: ${a} !== ${b}`);
    } else {
      assert.equal(a, b, `${field}: ${a} !== ${b}`);
    }
  }
  // stop/target don't depend on leverage, so these hold regardless of the effective cap:
  assert.equal(personaPlan.stopPrice, 58000);
  assert.equal(personaPlan.targetPrice, 64000);
});

test("AC-99a: sizing equality — persona channel behind the source rule (paper-passed source, experimental persona)", () => {
  const rule = sourceRule({ status: "paper-passed" });
  const plan = makeSourcePlan(rule); // venueIntent "live", real ladder leverage
  assert.equal(plan.venueIntent, "live");
  const ctx = makeCtx({ plan, rule }); // persona.channelStatus stays "experimental"
  const input = baseInput(plan.planId);
  assert.equal(validateDecision(input, ctx).ok, true);

  const attempt = planFromChoice(input.choice as Extract<DailyDecisionInput["choice"], { kind: "report-plan" }>, ctx);
  assert.ok(attempt && attempt.plan.kind === "plan");
  const personaPlan = attempt.plan as PlanRow;

  assert.equal(personaPlan.referencePrice, plan.referencePrice);
  assert.equal(personaPlan.stopPrice, plan.stopPrice);
  assert.equal(personaPlan.targetPrice, plan.targetPrice);
  assert.equal(personaPlan.expiresAt, plan.expiresAt);
  assert.equal(personaPlan.maxHoldDays, plan.maxHoldDays);
  assert.equal(personaPlan.leverage, 1);
  assert.equal(personaPlan.venueIntent, "paper");
});

// ── AC-100..103: persona-idea sizing and validation ─────────────────────────────────────────────

function baseIdea(overrides: Partial<PersonaIdea> = {}): PersonaIdea {
  return {
    symbol: "BTC/USDT", side: "long", thesis: "t", catalysts: [],
    refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "close", value: 60000 }],
    invalidateWhenAny: [], stopAtrMultiple: 2, targetRMultiple: 2, maxHoldDays: 5, confidence: 0.6,
    ...overrides,
  };
}

test("AC-100: persona idea sizing matches AC-11's numeric inputs, at the persona channel's own (experimental) leverage cap", () => {
  // Note: AC-100's literal numbers (riskUsd 1 / quantity 0.0005 / notionalUsd 30 / leverage 1)
  // are internally inconsistent with §5.5's normative sizing algorithm applied with an
  // experimental (leverage-1) persona rule: marginBudget (25) < notionalUsd (30) at leverage 1
  // forces the same rescale AC-11a/AC-13 exercise elsewhere, giving quantity 0.0004 / riskUsd 0.8
  // / notionalUsd 24 — not 0.0005/1/30. `planTrade` is unmodified (P9); this test asserts the
  // numbers the shared, unmodified sizing algorithm actually and correctly produces.
  const ctx = makeCtx();
  const input = baseInput((ctx.report.plans[0] as PlanRow).planId, {
    choice: { kind: "persona-idea", idea: baseIdea() },
  });
  const validation = validateDecision(input, ctx);
  assert.deepEqual(validation.rejections, []);

  const attempt = planFromChoice(input.choice as Extract<DailyDecisionInput["choice"], { kind: "persona-idea" }>, ctx);
  assert.ok(attempt && attempt.plan.kind === "plan");
  const plan = attempt.plan as PlanRow;
  assert.equal(plan.stopPrice, 58000);
  assert.equal(plan.targetPrice, 64000);
  assert.equal(plan.leverage, 1);
  assert.equal(plan.venueIntent, "paper");
  assert.equal(plan.quantity, 0.0004);
  assert.equal(plan.riskUsd, 0.8);
  assert.equal(plan.notionalUsd, 24);
  assert.ok(plan.planId.includes(`persona-${SKILL_HASH.slice(0, 8)}`));
});

test("AC-101: an idea citing a feature value that differs from the snapshot is rejected unverifiable_feature", () => {
  const ctx = makeCtx();
  const sourcePlanId = (ctx.report.plans[0] as PlanRow).planId;
  const input = baseInput(sourcePlanId, {
    choice: { kind: "persona-idea", idea: baseIdea({ refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "fundingRate8hAvg3d", value: 0.0003 }] }) },
  });
  const validation = validateDecision(input, ctx);
  assert.equal(validation.ok, false);
  assert.ok(validation.rejections.some((r) => r.code === "unverifiable_feature"));
});

test("AC-102: web-only evidence is rejected; feature+web evidence is accepted with the web ref recorded unverified", () => {
  const ctx = makeCtx();
  const sourcePlanId = (ctx.report.plans[0] as PlanRow).planId;

  const webOnly = baseInput(sourcePlanId, {
    choice: { kind: "persona-idea", idea: baseIdea({ refs: [{ kind: "web", url: "https://example.com" }] }) },
  });
  assert.ok(validateDecision(webOnly, ctx).rejections.some((r) => r.code === "web_only_evidence"));

  const noEvidence = baseInput(sourcePlanId, { choice: { kind: "persona-idea", idea: baseIdea({ refs: [] }) } });
  assert.ok(validateDecision(noEvidence, ctx).rejections.some((r) => r.code === "no_evidence"));

  const both = baseInput(sourcePlanId, {
    choice: {
      kind: "persona-idea",
      idea: baseIdea({ refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "close", value: 60000 }, { kind: "web", url: "https://example.com" }] }),
    },
  });
  const validation = validateDecision(both, ctx);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.unverifiedWebRefs.map((r) => r.url), ["https://example.com"]);
});

test("AC-103: an idea on an unconfigured symbol, or with out-of-range fields, is rejected", () => {
  const ctx = makeCtx();
  const sourcePlanId = (ctx.report.plans[0] as PlanRow).planId;

  const badSymbol = baseInput(sourcePlanId, { choice: { kind: "persona-idea", idea: baseIdea({ symbol: "SOL/USDT" }) } });
  assert.ok(validateDecision(badSymbol, ctx).rejections.some((r) => r.code === "symbol_not_configured"));

  const badRange = baseInput(sourcePlanId, {
    choice: { kind: "persona-idea", idea: baseIdea({ confidence: 1.5, stopAtrMultiple: 0, targetRMultiple: 21, maxHoldDays: 11 }) },
  });
  const rejections = validateDecision(badRange, ctx).rejections.filter((r) => r.code === "out_of_range");
  assert.equal(rejections.length, 4);
});

// ── AC-104: stance table checks ──────────────────────────────────────────────────────────────

test("AC-104: missing/unknown/duplicate stances are each reported precisely", () => {
  const rule2 = sourceRule({ id: "second-rule" });
  const plan1 = makeSourcePlan(sourceRule());
  const outcome2 = { ruleId: rule2.id, ruleHash: ruleHash(rule2), symbol: "BTC/USDT", result: "triggered" as const, evidence: {} };
  const plan2raw = planTrade(outcome2, rule2, FV_BTC, CFG, 1, false, DATE, 0, false, INSTRUMENT, DECISION_TIME);
  assert.equal(plan2raw.kind, "plan");
  const plan2 = plan2raw as PlanRow;

  const ctx = makeCtx({ report: makeReport([plan1, plan2]), ruleSet: { schemaVersion: 1, rules: [sourceRule(), rule2] } });

  const missing = baseInput(plan1.planId, { stances: [{ planId: plan1.planId, stance: "support", reasons: ["ok"] }] });
  const missingRejections = validateDecision(missing, ctx).rejections;
  assert.ok(missingRejections.some((r) => r.code === "missing_stance" && r.path === plan2.planId));

  const unknown = baseInput(plan1.planId, {
    stances: [
      { planId: plan1.planId, stance: "support", reasons: ["ok"] },
      { planId: plan2.planId, stance: "support", reasons: ["ok"] },
      { planId: "not-a-real-plan", stance: "oppose", reasons: ["x"] },
    ],
  });
  assert.ok(validateDecision(unknown, ctx).rejections.some((r) => r.code === "unknown_plan"));

  const duplicate = baseInput(plan1.planId, {
    stances: [
      { planId: plan1.planId, stance: "support", reasons: ["ok"] },
      { planId: plan1.planId, stance: "oppose", reasons: ["ok"] },
      { planId: plan2.planId, stance: "support", reasons: ["ok"] },
    ],
  });
  assert.ok(validateDecision(duplicate, ctx).rejections.some((r) => r.code === "duplicate_stance"));
});

// ── AC-105: expired report-plan vs. fresh persona-idea ──────────────────────────────────────────

test("AC-105: an expired report-plan choice is rejected; the same now with a persona-idea still succeeds", () => {
  const rule = sourceRule();
  const plan = makeSourcePlan(rule);
  const farFuture = plan.expiresAt + 1;
  const ctx = makeCtx({ plan, rule, now: farFuture });

  const expiredChoice = baseInput(plan.planId, {}); // now is set on ctx, not input
  const validation = validateDecision(expiredChoice, ctx);
  assert.ok(validation.rejections.some((r) => r.code === "expired"));

  const ideaInput = baseInput(plan.planId, { choice: { kind: "persona-idea", idea: baseIdea() } });
  assert.equal(validateDecision(ideaInput, ctx).ok, true);
});

// ── AC-106: no-trade ─────────────────────────────────────────────────────────────────────────

test("AC-106: a blank no-trade reason is rejected; a real one is accepted", () => {
  const ctx = makeCtx();
  const sourcePlanId = (ctx.report.plans[0] as PlanRow).planId;

  const blank = baseInput(sourcePlanId, { choice: { kind: "no-trade", reason: "   " } });
  assert.ok(validateDecision(blank, ctx).rejections.some((r) => r.code === "empty_reason"));

  const real = baseInput(sourcePlanId, { choice: { kind: "no-trade", reason: "breaker tripped" } });
  assert.equal(validateDecision(real, ctx).ok, true);
});

// ── personaIdeaToRule / reportPlanToPersonaRule / withPersonaProvenance / buildOwnerProtocol ────

test("AC-111: gating — experimental unless channelStatus paper-passed AND hash matches", () => {
  const idea = baseIdea();
  const experimental = personaIdeaToRule(idea, SKILL_HASH, PERSONA_CFG);
  assert.equal(experimental.status, "experimental");
  assert.equal(experimental.id, `persona-${SKILL_HASH.slice(0, 8)}`);
  assert.equal(experimental.forwardOnly, true);
  assert.equal(experimental.origin, "persona");

  const passedCfg: PersonaConfig = { ...PERSONA_CFG, channelStatus: "paper-passed", passedSkillHash: SKILL_HASH };
  const passed = personaIdeaToRule(idea, SKILL_HASH, passedCfg);
  assert.equal(passed.status, "paper-passed");

  const staleHashCfg: PersonaConfig = { ...PERSONA_CFG, channelStatus: "paper-passed", passedSkillHash: "b".repeat(64) };
  const stale = personaIdeaToRule(idea, SKILL_HASH, staleHashCfg);
  assert.equal(stale.status, "experimental");
});

test("reportPlanToPersonaRule copies the source rule's sizing fields and re-labels origin/id", () => {
  const rule = sourceRule({ stopAtrMultiple: 3, targetRMultiple: 4, maxHoldDays: 7 });
  const persona = reportPlanToPersonaRule(rule, SKILL_HASH, PERSONA_CFG);
  assert.equal(persona.side, rule.side);
  assert.equal(persona.stopAtrMultiple, 3);
  assert.equal(persona.targetRMultiple, 4);
  assert.equal(persona.maxHoldDays, 7);
  assert.equal(persona.origin, "persona");
  assert.equal(persona.forwardOnly, true);
  assert.equal(persona.entryWhenAll.length, 0);
});

test("withPersonaProvenance attaches basedOnPlanId/basedOnRuleKey without changing numbers", () => {
  const plan = makeSourcePlan(sourceRule());
  const withProv = withPersonaProvenance(plan, "some-plan-id", "rule@abcd1234");
  assert.equal(withProv.basedOnPlanId, "some-plan-id");
  assert.equal(withProv.basedOnRuleKey, "rule@abcd1234");
  for (const key of Object.keys(plan) as (keyof PlanRow)[]) {
    if (key === "basedOnPlanId" || key === "basedOnRuleKey") continue;
    assert.deepEqual(withProv[key], plan[key]);
  }
});

test("buildOwnerProtocol produces exactly 3 orders with the right reduce-only flags and windows", () => {
  const plan = makeSourcePlan(sourceRule());
  const protocol = buildOwnerProtocol(plan, 1000, PERSONA_CFG, NOW);
  assert.equal(protocol.orders.length, 3);
  const entry = protocol.orders.find((o) => o.kind === "entry")!;
  const stop = protocol.orders.find((o) => o.kind === "stop")!;
  const tp = protocol.orders.find((o) => o.kind === "take-profit")!;
  assert.equal(entry.reduceOnly, false);
  assert.equal(stop.reduceOnly, true);
  assert.equal(tp.reduceOnly, true);
  assert.equal(protocol.executeFrom, NOW);
  assert.equal(protocol.executeUntil, NOW + PERSONA_CFG.executionWindowMs);
  assert.equal(protocol.maxEntryGapAbs, 250); // 0.25 * 1000
  assert.deepEqual(protocol.entryBand, [plan.referencePrice - 250, plan.referencePrice + 250]);
  assert.equal(protocol.recordVia, "paper-api");
  assert.equal(protocol.timeExitOnOrBefore, NOW + plan.maxHoldDays * 24 * 60 * 60 * 1000);
});

// ── validateManage (AC-113, AC-120) ─────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<ManualTrade> = {}): ManualTrade {
  const plan = makeSourcePlan(sourceRule());
  return {
    id: "trade-a", venue: "paper", symbol: "BTC/USDT", side: "long", planId: plan.planId,
    ruleId: plan.ruleId, ruleHash: plan.ruleHash, plannedSnapshot: plan, aiStanceAtPlan: null,
    entryFills: [{ execId: "e1", time: NOW, price: 60000, qty: 0.0005, feeUsd: 0, side: "buy" }],
    exitFills: [], actualLeverage: 2, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function manageInput(tradeId: string, overrides: Partial<ManageInput> = {}): ManageInput {
  return { dateUtc: DATE, tradeId, action: { kind: "hold" }, thesis: "intact", reasons: ["ok"], news: [], ...overrides };
}

test("AC-113: tighten-stop out of range (widens risk or crosses entry) is rejected; a valid tighten succeeds", () => {
  const trade = makeTrade(); // referencePrice 60000, stopPrice 58000
  const ctx: ManageContext = { dateUtc: DATE, tradeArg: trade.id, trade, computedThesis: "intact", personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };

  const widens = manageInput(trade.id, { action: { kind: "tighten-stop", price: 55000 } });
  assert.ok(validateManage(widens, ctx).rejections.some((r) => r.code === "out_of_range"));

  const crosses = manageInput(trade.id, { action: { kind: "tighten-stop", price: 61000 } });
  assert.ok(validateManage(crosses, ctx).rejections.some((r) => r.code === "out_of_range"));

  const good = manageInput(trade.id, { action: { kind: "tighten-stop", price: 59000 } });
  assert.equal(validateManage(good, ctx).ok, true);
});

test("AC-113: trade_not_found / trade_not_open / trade_not_planned / empty_reason", () => {
  const notFoundCtx: ManageContext = { dateUtc: DATE, tradeArg: "ghost", trade: null, computedThesis: "not_evaluable", personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };
  assert.ok(validateManage(manageInput("ghost"), notFoundCtx).rejections.some((r) => r.code === "trade_not_found"));

  const closedTrade = makeTrade({ status: "closed" });
  const closedCtx: ManageContext = { dateUtc: DATE, tradeArg: closedTrade.id, trade: closedTrade, computedThesis: "intact", personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };
  assert.ok(validateManage(manageInput(closedTrade.id), closedCtx).rejections.some((r) => r.code === "trade_not_open"));

  const unplanned = makeTrade({ plannedSnapshot: null });
  const unplannedCtx: ManageContext = { dateUtc: DATE, tradeArg: unplanned.id, trade: unplanned, computedThesis: "not_evaluable", personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };
  assert.ok(validateManage(manageInput(unplanned.id, { thesis: "not_evaluable" }), unplannedCtx).rejections.some((r) => r.code === "trade_not_planned"));

  const trade = makeTrade();
  const ctx: ManageContext = { dateUtc: DATE, tradeArg: trade.id, trade, computedThesis: "intact", personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };
  assert.ok(validateManage(manageInput(trade.id, { reasons: ["   "] }), ctx).rejections.some((r) => r.code === "empty_reason"));
});

test("AC-120: thesis_mismatch — the persona reports the system's computed thesis, never its own", () => {
  const trade = makeTrade();
  const ctx: ManageContext = { dateUtc: DATE, tradeArg: trade.id, trade, computedThesis: "invalidated", personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };

  const mismatched = manageInput(trade.id, { thesis: "intact" });
  const rejection = validateManage(mismatched, ctx).rejections.find((r) => r.code === "thesis_mismatch");
  assert.ok(rejection);
  assert.equal(rejection!.path, "thesis");

  const matching = manageInput(trade.id, { thesis: "invalidated" });
  assert.equal(validateManage(matching, ctx).ok, true);
});

// ── validateReview (AC-114) ──────────────────────────────────────────────────────────────────

function reviewInput(tradeId: string, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return { dateUtc: DATE, tradeId, rMultiple: -1.1, exitKind: "stop", followedPlan: true, thesisVerdict: "confirmed", lesson: "learned", ...overrides };
}

test("AC-114: review mode requires exact agreement with the system's computed review", () => {
  const trade = makeTrade({ status: "closed" });
  const computed = {
    tradeId: trade.id, ruleId: trade.ruleId, ruleHash: trade.ruleHash, origin: "rules-file" as const,
    aiStanceAtPlan: null, basedOnRuleKey: null, plannedRiskUsd: 1, netPnlUsd: -1.1, feesUsd: 0, fundingUsd: 0,
    rMultiple: -1.1, entrySlippagePct: null, sizeDeviationPct: null, maePct: 0, mfePct: 0,
    exitKind: "stop" as const, followedPlan: true,
  };
  const ctx: ReviewContext = { dateUtc: DATE, tradeArg: trade.id, trade, computed, personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };

  assert.equal(validateReview(reviewInput(trade.id), ctx).ok, true);
  assert.ok(validateReview(reviewInput(trade.id, { rMultiple: -0.9 }), ctx).rejections.some((r) => r.code === "out_of_range"));
  assert.ok(validateReview(reviewInput(trade.id, { exitKind: "target" }), ctx).rejections.some((r) => r.code === "out_of_range"));
  assert.ok(validateReview(reviewInput(trade.id, { lesson: "" }), ctx).rejections.some((r) => r.code === "empty_reason"));

  const openTrade = makeTrade({ status: "open" });
  const openCtx: ReviewContext = { dateUtc: DATE, tradeArg: openTrade.id, trade: openTrade, computed: null, personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };
  assert.ok(validateReview(reviewInput(openTrade.id), openCtx).rejections.some((r) => r.code === "trade_not_closed"));

  const notFoundCtx: ReviewContext = { dateUtc: DATE, tradeArg: "ghost", trade: null, computed: null, personaCfg: PERSONA_CFG, skillHash: SKILL_HASH, now: NOW };
  assert.ok(validateReview(reviewInput("ghost"), notFoundCtx).rejections.some((r) => r.code === "trade_not_found"));
});
