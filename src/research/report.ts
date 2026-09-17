// Report — specs/daily-catalyst-manual-trading.md §5.6.
//
// buildReport is the pipeline's single computation point for rule outcomes and rule plans:
// the CLI's "order of operations" prose (§5.12: snapshots → features → rule outcomes → rule
// plans → buildReport → write) describes the pipeline's logical stages, but buildReport's own
// documented input (ruleSet, features, plannerConfig, breaker, openTrades — no separate
// outcomes/plans fields) is exactly what's needed to derive outcomes and plans internally, and
// DailyReport carries them as *output* fields. This file resolves that reading by computing
// outcomes/plans inside buildReport; see the phase report for the alternative considered.
//
// Phase 2 fixes (§9 table, until later phases land): liveClosedTradesForRule = 0,
// ladderResetByBreaker = false for every plan attempt (the journal/gate data that would supply
// real values doesn't exist until Phases 3–4).

import type { RuleDefinition, RuleOutcome, RuleSet, ThesisState } from "./rules.ts";
import { evaluateRule, evaluateThesis } from "./rules.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "./planner.ts";
import { instrumentFilters, planTrade } from "./planner.ts";
import type { FeatureName, FeatureVector, SourceSnapshot, SourceStatus } from "./types.ts";
import type { AiAnalystSection } from "./ai/types.ts";
import type { ManualTrade } from "../journal/types.ts";

export const DISCLAIMER = "Generated analysis for the owner's review. Not investment advice." as const;

export interface DailyReport {
  schemaVersion: 1;
  dateUtc: string;
  decisionTime: number;
  generatedAt: number;
  ruleSetSha256: string;
  sources: { sourceId: SourceSnapshot["sourceId"]; status: SourceStatus; statusDetail: string; fetchedAt: number; sha256: string }[];
  completeness: "complete" | "incomplete"; // "incomplete" iff any source status !== "ok"
  breaker: { tripped: boolean; trigger: string | null; details: string };
  outcomes: RuleOutcome[];
  plans: TradePlan[];
  openTradeThesis: { tradeId: string; ruleId: string; state: ThesisState; conditions: FeatureName[] }[];
  aiAnalyst: AiAnalystSection; // §5.13; status "disabled" when ai.enabled is false
  disclaimer: typeof DISCLAIMER;
}

function emptyAiSection(status: "pending" | "disabled", reason: string): AiAnalystSection {
  return {
    status, reason, model: null, servedByModel: null, promptVersionHash: null,
    costUsd: 0, monthToDateUsd: 0, regimeSummary: null,
    assessments: [], plans: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], rejected: [],
  };
}

/** aiAnalyst = { status: aiDisabledReason === null ? "pending" : "disabled",
 *    reason: null → "", "config" → "ai.enabled is false", "cli-flag" → "--no-ai"; all other
 *    fields empty/null/0 } */
function buildAiSection(aiDisabledReason: null | "config" | "cli-flag"): AiAnalystSection {
  if (aiDisabledReason === null) return emptyAiSection("pending", "");
  return emptyAiSection("disabled", aiDisabledReason === "config" ? "ai.enabled is false" : "--no-ai");
}

function findFeatureVector(features: readonly FeatureVector[], symbol: string): FeatureVector {
  const fv = features.find((f) => f.symbol === symbol);
  if (!fv) throw new Error(`buildReport: no FeatureVector for symbol "${symbol}" (required by a rule; features must cover every config symbol)`);
  return fv;
}

export function buildReport(input: {
  dateUtc: string;
  decisionTime: number;
  now: number;
  ruleSet: RuleSet;
  ruleSetSha256: string;
  snapshots: SourceSnapshot[];
  features: FeatureVector[];
  plannerConfig: PlannerConfig;
  breaker: { tripped: boolean; trigger: string | null; details: string };
  openTrades: ManualTrade[];
  aiDisabledReason: null | "config" | "cli-flag";
}): DailyReport {
  const {
    dateUtc, decisionTime, now, ruleSet, ruleSetSha256, snapshots, features,
    plannerConfig, breaker, openTrades, aiDisabledReason,
  } = input;

  const sources = snapshots.map((s) => ({
    sourceId: s.sourceId, status: s.status, statusDetail: s.statusDetail, fetchedAt: s.fetchedAt, sha256: s.sha256,
  }));
  const completeness: "complete" | "incomplete" = snapshots.every((s) => s.status === "ok") ? "complete" : "incomplete";

  const outcomes: RuleOutcome[] = [];
  const rulesById = new Map<string, RuleDefinition>();
  for (const rule of ruleSet.rules) {
    rulesById.set(rule.id, rule);
    for (const symbol of rule.symbols) {
      outcomes.push(evaluateRule(rule, findFeatureVector(features, symbol)));
    }
  }

  const symbolsWithInstruments = [...new Set(ruleSet.rules.flatMap((r) => r.symbols))];
  const instruments: Record<string, InstrumentFilter | null> = instrumentFilters(snapshots, symbolsWithInstruments);

  let openTradeCount = openTrades.filter((t) => t.status === "open").length;
  const plans: TradePlan[] = [];
  for (const outcome of outcomes) {
    if (outcome.result !== "triggered") continue;
    const rule = rulesById.get(outcome.ruleId)!;
    const fv = findFeatureVector(features, outcome.symbol);
    const plan = planTrade(
      outcome,
      rule,
      fv,
      plannerConfig,
      openTradeCount,
      breaker.tripped,
      dateUtc,
      /* liveClosedTradesForRule */ 0, // Phase 2 fixed (§9); real value arrives with Phase 4's gates
      /* ladderResetByBreaker */ false, // Phase 2 fixed (§9); real value arrives with Phase 4's gates
      instruments[outcome.symbol] ?? null,
      decisionTime,
    );
    if (plan.kind === "plan") openTradeCount += 1;
    plans.push(plan);
  }

  const openTradeThesis: DailyReport["openTradeThesis"] = [];
  for (const trade of openTrades) {
    if (trade.status !== "open" || trade.ruleId === null) continue;
    const rule = rulesById.get(trade.ruleId);
    const fv = features.find((f) => f.symbol === trade.symbol);
    if (!rule || !fv) {
      openTradeThesis.push({ tradeId: trade.id, ruleId: trade.ruleId, state: "not_evaluable", conditions: [] });
      continue;
    }
    const thesis = evaluateThesis(rule, fv);
    openTradeThesis.push({ tradeId: trade.id, ruleId: trade.ruleId, state: thesis.state, conditions: thesis.conditions });
  }

  return {
    schemaVersion: 1,
    dateUtc,
    decisionTime,
    generatedAt: now,
    ruleSetSha256,
    sources,
    completeness,
    breaker,
    outcomes,
    plans,
    openTradeThesis,
    aiAnalyst: buildAiSection(aiDisabledReason),
    disclaimer: DISCLAIMER,
  };
}

/** Pure. Appends ai.plans to plans (after rule plans) and sets aiAnalyst. Never modifies an
 *  existing plan. Channels are told apart by each plan's `origin`, not by position. */
export function attachAiAnalyst(report: DailyReport, ai: AiAnalystSection): DailyReport {
  return { ...report, plans: [...report.plans, ...ai.plans], aiAnalyst: ai };
}

// ── Markdown rendering ───────────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1e8) / 1e8) : String(n);
}

function renderOutcomeRow(o: RuleOutcome): string {
  if (o.result === "triggered") {
    const evidence = Object.entries(o.evidence).map(([k, v]) => `${k}=${fmtNum(v)}`).join(", ");
    return `| ${o.ruleId} | ${o.symbol} | triggered | ${evidence} |`;
  }
  if (o.result === "not_triggered") return `| ${o.ruleId} | ${o.symbol} | not_triggered | failed: ${o.failed.join(", ")} |`;
  return `| ${o.ruleId} | ${o.symbol} | not_evaluable | missing: ${o.missing.join(", ")} |`;
}

function renderPlanBlock(p: TradePlan, aiStance?: string): string {
  if (p.kind === "rejected") {
    return `- **${p.ruleId}** (${p.symbol}): rejected — \`${p.reason}\``;
  }
  const stance = aiStance ? ` — AI stance: ${aiStance}` : "";
  return [
    `- **${p.ruleId}** (${p.symbol}, ${p.side})${stance}`,
    `  - planId: \`${p.planId}\` | origin: ${p.origin} | venueIntent: ${p.venueIntent}`,
    `  - referencePrice: ${fmtNum(p.referencePrice)} | stopPrice: ${fmtNum(p.stopPrice)} | targetPrice: ${fmtNum(p.targetPrice)} | expiresAt: ${new Date(p.expiresAt).toISOString()}`,
    `  - quantity: ${fmtNum(p.quantity)} | notionalUsd: ${fmtNum(p.notionalUsd)} | riskUsd: ${fmtNum(p.riskUsd)} | leverage: ${p.leverage}x | marginUsd: ${fmtNum(p.marginUsd)}`,
    `  - estLiquidationPrice: ${fmtNum(p.estLiquidationPrice)} | liqToStopRatio: ${fmtNum(p.liqToStopRatio)} | estRoundTripFeeUsd: ${fmtNum(p.estRoundTripFeeUsd)}`,
  ].join("\n");
}

/** Markdown: completeness banner first line; then "Rules channel" (each rule plan with
 *  evidence values, source statuses and the AI stance next to it); then
 *  "AI analyst channel — forward-only, unvalidated" (regime summary, AI plans, open-trade
 *  notes, risks, data gaps, rejected-item count, cost). */
export function renderReportMarkdown(r: DailyReport): string {
  const lines: string[] = [];
  const bannerWord = r.completeness === "incomplete" ? "INCOMPLETE" : "COMPLETE";
  lines.push(`${bannerWord} — daily research report for ${r.dateUtc} (decisionTime ${new Date(r.decisionTime).toISOString()})`);
  lines.push("");
  lines.push(`Generated at ${new Date(r.generatedAt).toISOString()} | rule set sha256: \`${r.ruleSetSha256}\``);
  lines.push("");

  if (r.aiAnalyst.status === "pending") {
    lines.push("AI analyst: did not complete");
    lines.push("");
  }

  lines.push(`Breaker: ${r.breaker.tripped ? `TRIPPED (${r.breaker.trigger ?? "unknown"}) — ${r.breaker.details}` : "not tripped"}`);
  lines.push("");

  lines.push("## Sources");
  lines.push("");
  lines.push("| source | status | detail | fetchedAt | sha256 |");
  lines.push("|---|---|---|---|---|");
  for (const s of r.sources) {
    lines.push(`| ${s.sourceId} | ${s.status} | ${s.statusDetail || "-"} | ${new Date(s.fetchedAt).toISOString()} | \`${s.sha256.slice(0, 12)}\` |`);
  }
  lines.push("");

  lines.push("## Rules channel");
  lines.push("");
  lines.push("### Rule outcomes");
  lines.push("");
  lines.push("| rule | symbol | result | detail |");
  lines.push("|---|---|---|---|");
  for (const o of r.outcomes) lines.push(renderOutcomeRow(o));
  lines.push("");

  const rulePlans = r.plans.filter((p) => p.origin === "rules-file");
  const aiStanceByPlanId = new Map(r.aiAnalyst.assessments.map((a) => [a.planId, a.stance]));

  lines.push("### Rule plans");
  lines.push("");
  if (rulePlans.length === 0) {
    lines.push("_No plans this run._");
  } else {
    for (const p of rulePlans) {
      const stance = p.kind === "plan" ? aiStanceByPlanId.get(p.planId) : undefined;
      lines.push(renderPlanBlock(p, stance));
    }
  }
  lines.push("");

  if (r.openTradeThesis.length > 0) {
    lines.push("### Open-trade thesis");
    lines.push("");
    lines.push("| tradeId | rule | state | conditions |");
    lines.push("|---|---|---|---|");
    for (const t of r.openTradeThesis) {
      lines.push(`| ${t.tradeId} | ${t.ruleId} | ${t.state} | ${t.conditions.join(", ") || "-"} |`);
    }
    lines.push("");
  }

  if (r.aiAnalyst.status !== "disabled") {
    lines.push("## AI analyst channel — forward-only, unvalidated");
    lines.push("");
    lines.push(`Status: ${r.aiAnalyst.status}${r.aiAnalyst.reason ? ` — ${r.aiAnalyst.reason}` : ""}`);
    if (r.aiAnalyst.model) lines.push(`Model: ${r.aiAnalyst.model}${r.aiAnalyst.servedByModel && r.aiAnalyst.servedByModel !== r.aiAnalyst.model ? ` (served by ${r.aiAnalyst.servedByModel})` : ""}`);
    lines.push(`Cost: $${fmtNum(r.aiAnalyst.costUsd)} (month to date: $${fmtNum(r.aiAnalyst.monthToDateUsd)})`);
    lines.push("");
    if (r.aiAnalyst.regimeSummary) {
      lines.push("### Regime summary");
      lines.push("");
      lines.push(r.aiAnalyst.regimeSummary);
      lines.push("");
    }
    const aiPlans = r.plans.filter((p) => p.origin === "ai-analyst");
    lines.push("### AI plans");
    lines.push("");
    if (aiPlans.length === 0) {
      lines.push("_No AI plans this run._");
    } else {
      for (const p of aiPlans) lines.push(renderPlanBlock(p));
    }
    lines.push("");
    if (r.aiAnalyst.openTradeNotes.length > 0) {
      lines.push("### Open-trade notes");
      lines.push("");
      for (const n of r.aiAnalyst.openTradeNotes) lines.push(`- ${n.tradeId}: ${n.note}`);
      lines.push("");
    }
    if (r.aiAnalyst.risks.length > 0) {
      lines.push("### Risks");
      lines.push("");
      for (const risk of r.aiAnalyst.risks) lines.push(`- ${risk}`);
      lines.push("");
    }
    if (r.aiAnalyst.dataGaps.length > 0) {
      lines.push("### Data gaps");
      lines.push("");
      for (const gap of r.aiAnalyst.dataGaps) lines.push(`- ${gap}`);
      lines.push("");
    }
    lines.push(`Rejected items: ${r.aiAnalyst.rejected.length}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(r.disclaimer);
  lines.push("");

  return lines.join("\n");
}
