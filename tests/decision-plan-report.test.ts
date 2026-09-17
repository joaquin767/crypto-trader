// Plan Report rendering tests — specs/daily-catalyst-manual-trading.md §5.6a, AC-112, AC-119.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RuleDefinition } from "../src/research/rules.ts";
import { ruleHash } from "../src/research/rules.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "../src/research/planner.ts";
import { planTrade } from "../src/research/planner.ts";
import type { FeatureValue, FeatureVector } from "../src/research/types.ts";
import type { DailyReport } from "../src/research/report.ts";
import type { PersonaConfig } from "../src/config.ts";
import { buildOwnerProtocol, personaIdeaToRule, withPersonaProvenance } from "../src/decision/decide.ts";
import { renderPlanReport } from "../src/decision/plan-report.ts";
import type { OtherOpenTradeRow } from "../src/decision/plan-report.ts";
import type { DailyDecision } from "../src/decision/types.ts";

type PlanRow = Extract<TradePlan, { kind: "plan" }>;

function closeAndAtr(close: number, atr14d: number): Record<string, FeatureValue> {
  const missing = (feature: string): FeatureValue => ({ kind: "missing", reason: `unused: ${feature}`, sourceId: "bybit-klines-1d" });
  return {
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
}

const DATE = "2026-09-18";
const DECISION_TIME = Date.parse(`${DATE}T00:15:00Z`);
const DECIDED_AT = DECISION_TIME + 26 * 60 * 1000; // 00:41 UTC
const FV: FeatureVector = { symbol: "BTC/USDT", decisionTime: DECISION_TIME, features: closeAndAtr(60000, 1000) as FeatureVector["features"] };
const INSTRUMENT: InstrumentFilter = { minOrderQty: 0.0001, qtyStep: 0.0001, minNotionalValue: 5 };
const CFG: PlannerConfig = {
  maxCapitalUsd: 100, riskPerTradePercent: 1, maxLeverage: 5, liveLadderCap: 2,
  marginBudgetPercent: 25, maintenanceMarginRate: 0.005, minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11, maxOpenManualTrades: 3,
};
const SKILL_HASH = "3f9a1c2b".padEnd(64, "0");
const PERSONA_CFG: PersonaConfig = {
  executionWindowMs: 21_600_000, maxEntryGapAtr: 0.25, channelStatus: "experimental",
  passedSkillHash: null, ownerTimeZone: "America/Argentina/Buenos_Aires",
  decisionsRoot: "data/decisions", skillRoot: ".claude/skills/crypto-fundamental-analyst",
};

const RULE: RuleDefinition = {
  id: "etf-flow-momentum", version: 1, description: "d", evidence: ["X1"], status: "paper-passed",
  symbols: ["BTC/USDT"], side: "long",
  entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
  stopAtrMultiple: 2, targetRMultiple: 2, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
};

function makeSourcePlan(): PlanRow {
  const outcome = { ruleId: RULE.id, ruleHash: ruleHash(RULE), symbol: "BTC/USDT", result: "triggered" as const, evidence: {} };
  const plan = planTrade(outcome, RULE, FV, CFG, 0, false, DATE, 0, false, INSTRUMENT, DECISION_TIME);
  assert.equal(plan.kind, "plan");
  return plan as PlanRow;
}

function makeReport(sourcePlan: PlanRow): DailyReport {
  return {
    schemaVersion: 1, dateUtc: DATE, decisionTime: DECISION_TIME, generatedAt: DECISION_TIME,
    ruleSetSha256: "deadbeef", sources: [], completeness: "complete",
    breaker: { tripped: false, trigger: null, details: "" },
    outcomes: [], plans: [sourcePlan], openTradeThesis: [],
    aiAnalyst: {
      status: "disabled", reason: "", model: null, provider: null, servedByModel: null, promptVersionHash: null,
      costUsd: 0, monthToDateUsd: 0, listCostUsd: 0, regimeSummary: null,
      assessments: [], plans: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], rejected: [],
    },
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };
}

function makeDecision(): { decision: DailyDecision; report: DailyReport } {
  const sourcePlan = makeSourcePlan();
  const report = makeReport(sourcePlan);
  const personaRule = personaIdeaToRule(
    { symbol: "BTC/USDT", side: "long", thesis: "t", catalysts: [], refs: [], invalidateWhenAny: [], stopAtrMultiple: 2, targetRMultiple: 2, maxHoldDays: 5, confidence: 0.6 },
    SKILL_HASH, PERSONA_CFG,
  );
  const rawPlan = { ...sourcePlan, planId: `${DATE}:${personaRule.id}:BTC/USDT`, ruleId: personaRule.id, ruleHash: SKILL_HASH, origin: "persona" as const };
  const plan = withPersonaProvenance(rawPlan, sourcePlan.planId, `${RULE.id}@${ruleHash(RULE).slice(0, 8)}`);
  const ownerProtocol = buildOwnerProtocol(plan, 1000, PERSONA_CFG, DECIDED_AT);

  const decision: DailyDecision = {
    schemaVersion: 1, dateUtc: DATE, revision: 0, decidedAt: DECIDED_AT, skillHash: SKILL_HASH,
    reportPath: `reports/${DATE}.json`, reportSha256: "8c1d4f0a".padEnd(64, "0"), reportDecisionTime: DECISION_TIME,
    input: {
      dateUtc: DATE, choice: { kind: "report-plan", planId: sourcePlan.planId },
      stances: [{ planId: sourcePlan.planId, stance: "support", reasons: ["ETF flows strong"] }],
      news: [], rationale: "Following the strongest rule plan today.",
    },
    validation: { ok: true, rejections: [], unverifiedWebRefs: [] },
    plan, personaRule, basedOnPlanId: sourcePlan.planId, basedOnRuleKey: `${RULE.id}@${ruleHash(RULE).slice(0, 8)}`,
    ownerProtocol,
    ownerTimeZone: PERSONA_CFG.ownerTimeZone,
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };
  return { decision, report };
}

test("AC-112: Plan Report contains the execute window (UTC and owner timezone), the gap band, exactly 3 order rows, and per-trade artifact paths", () => {
  const { decision, report } = makeDecision();
  const md = renderPlanReport(decision, report);

  assert.match(md, /# Plan Report — 2026-09-18/);
  assert.match(md, /UTC → \*\*.*UTC\*\*/);
  assert.match(md, /UTC−3/);
  assert.match(md, /59,?750\.00 – 60,?250\.00|59750\.00 – 60250\.00/); // referencePrice ± 0.25*atr14d(1000)=250

  const orderRows = md.split("\n").filter((l) => /^\|\s*[123]\s*\|/.test(l));
  assert.equal(orderRows.length, 3);
  assert.match(orderRows[0]!, /\bno\b/); // entry row: reduce-only "no"
  assert.match(orderRows[1]!, /\*\*yes\*\*/); // stop row
  assert.match(orderRows[2]!, /\*\*yes\*\*/); // take-profit row

  assert.match(md, /\| When \| You do \| Then \|/);
  assert.match(md, /Position closed/);
  assert.match(md, /still open/);
  assert.match(md, /00:15 UTC/);
  assert.match(md, /journal dashboard/);
  assert.match(md, /alerts only/);

  assert.match(md, /data\/decisions\/2026-09-18\.manage\./);
  assert.match(md, /data\/decisions\/2026-09-18\.review\./);
  assert.doesNotMatch(md, /manage\.json/); // never the date-only form

  assert.match(md, new RegExp(decision.plan!.planId));

  const lines = md.trim().split("\n");
  assert.equal(lines[lines.length - 1], "Generated analysis for the owner's review. Not investment advice.");
});

test("AC-106: a no-trade decision still renders sections 2, 4 and 7", () => {
  const { decision, report } = makeDecision();
  const noTradeDecision: DailyDecision = {
    ...decision, plan: null, ownerProtocol: null, personaRule: null, basedOnPlanId: null, basedOnRuleKey: null,
    input: { ...decision.input, choice: { kind: "no-trade", reason: "breaker tripped" } },
  };
  const md = renderPlanReport(noTradeDecision, report);
  assert.match(md, /\*\*No trade today\.\*\* breaker tripped/);
  assert.match(md, /## 2\. When to come back/);
  assert.match(md, /## 4\. Stances on every plan in today's report/);
  assert.match(md, /## 7\. Other open positions/);
  // The second clock column comes from the decision's own ownerTimeZone, not from the (null)
  // ownerProtocol — the first real no-trade run printed "UTC+0" here.
  assert.match(md, /decided \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC-3\)/);
  assert.doesNotMatch(md, /UTC\+0\)/);
  // The no-trade come-back table still names the paper-exit recording step for earlier positions.
  assert.match(md, /Position closed[^\n]*POST \/api\/paper\/exit/);
});

test("AC-119: other open positions lists exactly the other open trades, and excludes the decision's own", () => {
  const { decision, report } = makeDecision();
  const others: OtherOpenTradeRow[] = [
    { tradeId: "7c1f0000", symbol: "ETH/USDT", side: "long", planId: `2026-09-15:persona-3f9a1c2b:ETH/USDT` },
  ];
  const md = renderPlanReport(decision, report, others);
  assert.match(md, /7c1f0000/);
  assert.match(md, /ETH\/USDT/);
  assert.match(md, /data\/decisions\/2026-09-18\.manage\.7c1f0000\.json/);

  const noneMd = renderPlanReport(decision, report, []);
  assert.match(noneMd, /## 7\. Other open positions\n\nNone\./);
});

test("News: not checked literal when no news items are given", () => {
  const { decision, report } = makeDecision();
  const md = renderPlanReport(decision, report);
  assert.match(md, /News: not checked/);
});

test("unverified web refs are listed in section 6 with the word 'unverified'", () => {
  const { decision, report } = makeDecision();
  const withWebRef: DailyDecision = {
    ...decision,
    validation: { ok: true, rejections: [], unverifiedWebRefs: [{ path: "choice.idea.refs[1]", url: "https://example.com/news" }] },
  };
  const md = renderPlanReport(withWebRef, report);
  assert.match(md, /https:\/\/example\.com\/news/);
  assert.match(md, /unverified/);
});
