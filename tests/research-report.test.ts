// Report tests — specs/daily-catalyst-manual-trading.md §5.6, AC-14a, AC-16..19.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RuleDefinition, RuleSet } from "../src/research/rules.ts";
import { ruleHash } from "../src/research/rules.ts";
import type { PlannerConfig } from "../src/research/planner.ts";
import type { FeatureValue, FeatureVector, SourceSnapshot } from "../src/research/types.ts";
import type { DailyReport } from "../src/research/report.ts";
import { attachAiAnalyst, buildReport, DISCLAIMER, renderReportMarkdown } from "../src/research/report.ts";
import type { AiAnalystSection } from "../src/research/ai/types.ts";
import type { ManualTrade } from "../src/journal/types.ts";

const CFG: PlannerConfig = {
  maxCapitalUsd: 100, riskPerTradePercent: 1, maxLeverage: 5, liveLadderCap: 2,
  marginBudgetPercent: 25, maintenanceMarginRate: 0.005, minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11, maxOpenManualTrades: 3,
};

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "r1", version: 1, description: "d", evidence: ["X1"], status: "paper-passed",
    symbols: ["BTC/USDT"], side: "long",
    entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
    stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
    ...overrides,
  };
}

function fv(symbol: string, close: number, atr14d: number): FeatureVector {
  const missing = (sourceId: FeatureValue extends { sourceId: infer S } ? S : never): FeatureValue => ({ kind: "missing", reason: "n/a", sourceId });
  return {
    symbol, decisionTime: 0,
    features: {
      close: { kind: "value", value: close, availableAt: 0, sourceId: "bybit-klines-1d" },
      atr14d: { kind: "value", value: atr14d, availableAt: 0, sourceId: "bybit-klines-1d" },
      return1d: missing("bybit-klines-1d"), return7d: missing("bybit-klines-1d"), realizedVol7d: missing("bybit-klines-1d"),
      fundingRate8hAvg3d: missing("bybit-funding"), fundingRatePercentile90d: missing("bybit-funding"),
      oiChange3dPct: missing("bybit-oi"),
      btcEtfNetFlowUsd1d: missing("farside-btc-etf"), btcEtfNetFlowUsd5d: missing("farside-btc-etf"),
      ethEtfNetFlowUsd1d: missing("farside-eth-etf"),
      stablecoinSupplyChange7dPct: missing("defillama-stablecoins"), fearGreed: missing("fear-greed"),
      hoursToNextFomc: missing("macro-calendar-manual"), hoursToNextCpi: missing("fred-release-dates"),
      daysToNextUnlock: missing("unlocks-manual"), nextUnlockPctOfFloat: missing("unlocks-manual"),
    },
  };
}

function okSnap(sourceId: SourceSnapshot["sourceId"]): SourceSnapshot {
  return { sourceId, fetchedAt: 0, status: "ok", statusDetail: "", sha256: "x", rows: [] };
}

const INSTRUMENT_SNAPSHOT: SourceSnapshot = {
  sourceId: "bybit-instruments", fetchedAt: 0, status: "ok", statusDetail: "", sha256: "x",
  rows: [
    { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "minOrderQty", value: 0.0001 },
    { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "qtyStep", value: 0.0001 },
    { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "minNotionalValue", value: 5 },
  ],
};

function buildInput(overrides: Partial<Parameters<typeof buildReport>[0]> = {}) {
  return {
    dateUtc: "2026-09-16",
    decisionTime: 0,
    now: 1000,
    ruleSet: { schemaVersion: 1 as const, rules: [rule()] },
    ruleSetSha256: "abc123",
    snapshots: [okSnap("bybit-klines-1d"), INSTRUMENT_SNAPSHOT],
    features: [fv("BTC/USDT", 60000, 1000)],
    plannerConfig: CFG,
    breaker: { tripped: false, trigger: null, details: "" },
    openTrades: [] as ManualTrade[],
    aiDisabledReason: "config" as const,
    ...overrides,
  };
}

// ── AC-16/17 ─────────────────────────────────────────────────────────────────────────────────

test("AC-16: any source not ok -> completeness incomplete and Markdown starts with INCOMPLETE", () => {
  const report = buildReport(buildInput({ snapshots: [{ ...okSnap("bybit-klines-1d"), status: "unavailable", statusDetail: "down" }, INSTRUMENT_SNAPSHOT] }));
  assert.equal(report.completeness, "incomplete");
  const md = renderReportMarkdown(report);
  assert.ok(md.startsWith("INCOMPLETE"));
});

test("AC-16 (complement): every source ok -> complete and Markdown starts with COMPLETE", () => {
  const report = buildReport(buildInput());
  assert.equal(report.completeness, "complete");
  assert.ok(renderReportMarkdown(report).startsWith("COMPLETE"));
});

test("AC-17: disclaimer is the exact literal, present in both the report and the Markdown", () => {
  const report = buildReport(buildInput());
  assert.equal(report.disclaimer, DISCLAIMER);
  assert.equal(DISCLAIMER, "Generated analysis for the owner's review. Not investment advice.");
  assert.ok(renderReportMarkdown(report).includes(DISCLAIMER));
});

// ── AC-19 (via buildReport's openTradeThesis wiring) ───────────────────────────────────────

test("AC-19: an open trade whose rule's invalidateWhenAny fires -> openTradeThesis invalidated", () => {
  const r = rule({ id: "r1", invalidateWhenAny: [{ feature: "close", op: ">", value: 1 }] });
  const trade: ManualTrade = {
    id: "trade-1", venue: "paper", symbol: "BTC/USDT", side: "long", planId: "p1",
    ruleId: "r1", ruleHash: ruleHash(r), plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [], exitFills: [], actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: 0, updatedAt: 0,
  };
  const report = buildReport(buildInput({ ruleSet: { schemaVersion: 1, rules: [r] }, openTrades: [trade] }));
  assert.equal(report.openTradeThesis.length, 1);
  assert.equal(report.openTradeThesis[0]!.state, "invalidated");
});

// ── AC-14a ──────────────────────────────────────────────────────────────────────────────────

test("AC-14a: maxOpenManualTrades=3, 1 open trade, 4 triggering rules -> exactly 2 plans and 2 max_open_trades rejections", () => {
  const rules: RuleDefinition[] = ["r1", "r2", "r3", "r4"].map((id) => rule({ id, symbols: ["BTC/USDT"] }));
  const openTrade: ManualTrade = {
    id: "t0", venue: "paper", symbol: "BTC/USDT", side: "long", planId: null, ruleId: null, ruleHash: null,
    plannedSnapshot: null, aiStanceAtPlan: null, entryFills: [], exitFills: [], actualLeverage: null,
    exchangeLiqPrice: null, fundingUsd: 0, status: "open", exitKind: null, notes: "", createdAt: 0, updatedAt: 0,
  };
  const cfg: PlannerConfig = { ...CFG, maxOpenManualTrades: 3 };
  const report = buildReport(buildInput({
    ruleSet: { schemaVersion: 1, rules }, openTrades: [openTrade], plannerConfig: cfg,
  }));
  const planned = report.plans.filter((p) => p.kind === "plan");
  const rejectedMax = report.plans.filter((p) => p.kind === "rejected" && p.reason === "max_open_trades");
  assert.equal(planned.length, 2);
  assert.equal(rejectedMax.length, 2);
  // the last two in rule order are rejected
  assert.deepEqual(rejectedMax.map((p) => p.ruleId), ["r3", "r4"]);
});

// ── attachAiAnalyst ─────────────────────────────────────────────────────────────────────────

function emptyAiSection(overrides: Partial<AiAnalystSection> = {}): AiAnalystSection {
  return {
    status: "ok", reason: "", model: "claude-opus-5", provider: "anthropic-api", servedByModel: "claude-opus-5", promptVersionHash: "hash",
    costUsd: 0.1, monthToDateUsd: 0.1, listCostUsd: 0.1, regimeSummary: "calm", assessments: [], plans: [], ideas: [],
    openTradeNotes: [], risks: [], dataGaps: [], rejected: [],
    ...overrides,
  };
}

test("attachAiAnalyst appends ai.plans after rule plans and never mutates existing plans", () => {
  const report = buildReport(buildInput());
  const originalPlans = [...report.plans];
  const aiPlan = { ...(originalPlans[0] as Extract<DailyReport["plans"][number], { kind: "plan" }>), planId: "ai-plan-1", ruleId: "ai-analyst-abcd1234", origin: "ai-analyst" as const };
  const ai = emptyAiSection({ plans: [aiPlan] });
  const attached = attachAiAnalyst(report, ai);

  assert.deepEqual(attached.plans.slice(0, originalPlans.length), originalPlans);
  assert.deepEqual(attached.plans[attached.plans.length - 1], aiPlan);
  assert.equal(attached.aiAnalyst, ai);
  // original report object is untouched (pure function)
  assert.deepEqual(report.plans, originalPlans);
});

test("renderReportMarkdown places a rejected AI-origin plan under the AI channel, never under Rule plans", () => {
  const report = buildReport(buildInput());
  const aiRejected = { kind: "rejected" as const, ruleId: "ai-analyst-abcd1234", origin: "ai-analyst" as const, symbol: "BTC/USDT", reason: "size_below_min" as const };
  const md = renderReportMarkdown(attachAiAnalyst(report, emptyAiSection({ plans: [aiRejected] })));
  const aiHeadingAt = md.indexOf("AI analyst channel — forward-only, unvalidated");
  const mentionAt = md.indexOf("ai-analyst-abcd1234");
  assert.ok(aiHeadingAt > 0 && mentionAt > aiHeadingAt, "AI-origin rejection must render after the AI heading");
});

// ── AC-52-style rendering check (structure only; full AI behavior is Phase 4b) ─────────────

test("renderReportMarkdown shows the AI heading exactly once when aiAnalyst.status !== disabled, never when disabled", () => {
  const report = buildReport(buildInput());
  const disabledMd = renderReportMarkdown(report);
  assert.equal((disabledMd.match(/AI analyst channel — forward-only, unvalidated/g) ?? []).length, 0);

  const attached = attachAiAnalyst(report, emptyAiSection({ status: "ok" }));
  const okMd = renderReportMarkdown(attached);
  assert.equal((okMd.match(/AI analyst channel — forward-only, unvalidated/g) ?? []).length, 1);
});

test("renderReportMarkdown: a pending AI status shows 'AI analyst: did not complete'", () => {
  const report = buildReport(buildInput({ aiDisabledReason: null }));
  assert.equal(report.aiAnalyst.status, "pending");
  const md = renderReportMarkdown(report);
  assert.ok(md.includes("AI analyst: did not complete"));
});

// ── AC-49a ──────────────────────────────────────────────────────────────────────────────────

test("AC-49a: aiDisabledReason wiring", () => {
  const pending = buildReport(buildInput({ aiDisabledReason: null }));
  assert.equal(pending.aiAnalyst.status, "pending");
  assert.equal(pending.aiAnalyst.reason, "");

  const configDisabled = buildReport(buildInput({ aiDisabledReason: "config" }));
  assert.equal(configDisabled.aiAnalyst.status, "disabled");
  assert.equal(configDisabled.aiAnalyst.reason, "ai.enabled is false");

  const cliDisabled = buildReport(buildInput({ aiDisabledReason: "cli-flag" }));
  assert.equal(cliDisabled.aiAnalyst.status, "disabled");
  assert.equal(cliDisabled.aiAnalyst.reason, "--no-ai");
});

// ── AC-53 ───────────────────────────────────────────────────────────────────────────────────

function aiOriginTrade(ruleId: string): ManualTrade {
  return {
    id: "ai-trade-1", venue: "paper", symbol: "BTC/USDT", side: "long", planId: "2026-09-16:ai-analyst-abcd1234:BTC/USDT",
    ruleId, ruleHash: "hash", plannedSnapshot: null, aiStanceAtPlan: null, entryFills: [], exitFills: [],
    actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0, status: "open", exitKind: null,
    notes: "", createdAt: 0, updatedAt: 0,
  };
}

test("AC-53: an open AI-origin trade whose ai-rules file was never loaded -> openTradeThesis not_evaluable", () => {
  const trade = aiOriginTrade("ai-analyst-abcd1234");
  const report = buildReport(buildInput({ openTrades: [trade] })); // no `aiRules` map passed
  assert.equal(report.openTradeThesis.length, 1);
  assert.equal(report.openTradeThesis[0]!.state, "not_evaluable");
});

test("an open AI-origin trade whose persisted rule IS supplied gets a real thesis evaluation", () => {
  const trade = aiOriginTrade("ai-analyst-abcd1234");
  const aiRule = rule({ id: "ai-analyst-abcd1234", origin: "ai-analyst", invalidateWhenAny: [{ feature: "close", op: ">", value: 1 }] });
  const report = buildReport(buildInput({ openTrades: [trade], aiRules: { "ai-analyst-abcd1234": aiRule } }));
  assert.equal(report.openTradeThesis.length, 1);
  assert.equal(report.openTradeThesis[0]!.state, "invalidated");
});
