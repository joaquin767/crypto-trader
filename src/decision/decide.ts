// Persona decision channel — validation, rule synthesis, owner protocol.
// specs/daily-catalyst-manual-trading.md §5.15 (revision 3, Phase 6).
//
// Pure throughout (verification gate §12.14): no fs/network I/O. `skillHash` is the sole
// exception and lives in its own file (src/decision/skill-hash.ts). The CLI
// (scripts/decide-daily.ts) does all reading and writing; this file only validates, sizes
// (via the shared, unmodified `planTrade`) and assembles the typed artifacts.
//
// Spec-gap resolutions (flagged, same discipline as src/research/planner.ts's file header):
//  - §5.15's `validateDecision(input: DailyDecisionInput, ...)` takes an already-typed input,
//    but the rejection table's first row is "Input is not JSON, or does not match
//    DailyDecisionInput -> schema_invalid" — a check that can only run on unparsed JSON.
//    `parseDailyDecisionInput`/`parseManageInput`/`parseReviewInput` below do that shape check
//    (mirroring parseRuleSet's `unknown -> typed` pattern); the CLI runs them first and only
//    calls the typed `validateDecision`/`validateManage`/`validateReview` when the shape is good.
//  - "replan_rejected" requires actually running `planTrade` to see whether it rejects — so
//    `validateDecision` calls the same `planFromChoice` helper that `runDecide` calls again
//    afterwards to build the persisted artifact. `planTrade` is pure and deterministic, so
//    calling it twice with identical inputs is cheap and never disagrees with itself.
//  - `DecisionContext.aiRules` is keyed by planId (not ruleId): decide.ts always needs the rule
//    for one specific chosen plan, never "the currently open trade's rule" the way
//    src/research/report.ts's `aiRules` (keyed by ruleId) does.

import type { AiEvidenceRef } from "../research/ai/types.ts";
import type { Condition, RuleDefinition } from "../research/rules.ts";
import { ruleHash } from "../research/rules.ts";
import type { TradePlan } from "../research/planner.ts";
import { planTrade } from "../research/planner.ts";
import type { PersonaConfig } from "../config.ts";
import type {
  DailyDecisionInput, DecisionContext, DecisionRejection, DecisionRejectionCode, DecisionValidation,
  ManageContext, ManageInput, OwnerProtocol, OwnerProtocolOrder, PersonaChoice, PersonaIdea,
  PersonaNewsItem, PersonaStance, ReviewContext, ReviewInput,
} from "./types.ts";

type PlanRow = Extract<TradePlan, { kind: "plan" }>;

const FEATURE_TOLERANCE_ABS = 1e-9;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function reject(code: DecisionRejectionCode, path: string, detail: string): DecisionRejection {
  return { code, path, detail };
}

/** A `kind:"rejected"` TradePlan carries no `planId` field (only `kind:"plan"` does), but its
 *  ruleId+symbol deterministically imply the planId `planTrade` would have used had it not been
 *  rejected (`${dateUtc}:${ruleId}:${symbol}`, §5.5) — this is how a `not_a_plan` rejection
 *  (§5.15: "the named plan exists but is kind:'rejected'") can ever be distinguished from
 *  `unknown_plan` at all. */
function findReportPlanById(report: DecisionContext["report"], dateUtc: string, planId: string): TradePlan | null {
  return report.plans.find((p) => (p.kind === "plan" ? p.planId : `${dateUtc}:${p.ruleId}:${p.symbol}`) === planId) ?? null;
}

// ── personaIdeaToRule / reportPlanToPersonaRule (§5.15) ─────────────────────────────────────────

function personaStatus(skillHash: string, cfg: PersonaConfig): RuleDefinition["status"] {
  return cfg.channelStatus === "paper-passed" && cfg.passedSkillHash === skillHash ? "paper-passed" : "experimental";
}

/** Pure. Mirrors aiIdeaToRule (§5.13) exactly, with: id `persona-<skillHash.slice(0,8)>`,
 *  version 1, description idea.thesis, evidence [], symbols [idea.symbol], side idea.side,
 *  entryWhenAll [], invalidateWhenAny / stopAtrMultiple / targetRMultiple / maxHoldDays copied
 *  from the idea, forwardOnly true, origin "persona", and status per §5.15/§8.5. */
export function personaIdeaToRule(idea: PersonaIdea, skillHash: string, cfg: PersonaConfig): RuleDefinition {
  return {
    id: `persona-${skillHash.slice(0, 8)}`,
    version: 1,
    description: idea.thesis,
    evidence: [],
    status: personaStatus(skillHash, cfg),
    symbols: [idea.symbol],
    side: idea.side,
    entryWhenAll: [],
    invalidateWhenAny: idea.invalidateWhenAny,
    stopAtrMultiple: idea.stopAtrMultiple,
    targetRMultiple: idea.targetRMultiple,
    maxHoldDays: idea.maxHoldDays,
    forwardOnly: true,
    origin: "persona",
  };
}

/** Pure. The rule used to re-plan a chosen report plan: the SOURCE rule's side,
 *  stopAtrMultiple, targetRMultiple, maxHoldDays and invalidateWhenAny, re-labelled as the
 *  persona channel — id `persona-<hash8>`, origin "persona", forwardOnly true, entryWhenAll [],
 *  evidence [], status as in personaIdeaToRule. Sizing inputs are therefore identical to the
 *  source plan's. */
export function reportPlanToPersonaRule(sourceRule: RuleDefinition, skillHash: string, cfg: PersonaConfig): RuleDefinition {
  return {
    id: `persona-${skillHash.slice(0, 8)}`,
    version: 1,
    description: sourceRule.description,
    evidence: [],
    status: personaStatus(skillHash, cfg),
    symbols: sourceRule.symbols,
    side: sourceRule.side,
    entryWhenAll: [],
    invalidateWhenAny: sourceRule.invalidateWhenAny,
    stopAtrMultiple: sourceRule.stopAtrMultiple,
    targetRMultiple: sourceRule.targetRMultiple,
    maxHoldDays: sourceRule.maxHoldDays,
    forwardOnly: true,
    origin: "persona",
  };
}

/** Pure. Attaches persona provenance to a plan produced by `planTrade`; changes no number and no
 *  other field. `planTrade` itself is NOT modified by revision 3 (P9). */
export function withPersonaProvenance(
  plan: PlanRow,
  basedOnPlanId: string | null,
  basedOnRuleKey: string | null,
): PlanRow {
  return { ...plan, basedOnPlanId, basedOnRuleKey };
}

// ── Sizing (§5.15 "Sizing (P9 — the system sizes, always)") ─────────────────────────────────────

function findSourceRule(plan: PlanRow, ctx: DecisionContext): RuleDefinition | null {
  if (plan.origin === "rules-file") {
    return ctx.ruleSet.rules.find((r) => r.id === plan.ruleId) ?? null;
  }
  if (plan.origin === "ai-analyst") {
    return ctx.aiRules[plan.planId] ?? null;
  }
  return null; // a persona-origin plan can never itself be the "source" of a report-plan choice
}

/** Runs the shared `planTrade` for either choice kind, using the report's own decisionTime (so a
 *  report-plan choice reproduces the source plan's numbers exactly, AC-99) and today's live
 *  open-trade count (§5.15: "openTradeCount = the number of status:'open' journal trades (both
 *  venues) only"). Returns the raw `TradePlan` (before persona provenance is attached) plus the
 *  synthesized `RuleDefinition`, or `null` when the choice can't even be attempted (e.g. an
 *  unknown/expired/non-plan report-plan choice — those are already separately rejected). */
export function planFromChoice(
  choice: Extract<PersonaChoice, { kind: "report-plan" | "persona-idea" }>,
  ctx: DecisionContext,
): { plan: TradePlan; rule: RuleDefinition; sourcePlan: PlanRow | null; sourceRule: RuleDefinition | null } | null {
  const openTradeCount = ctx.journal.filter((t) => t.status === "open").length;

  if (choice.kind === "persona-idea") {
    const idea = choice.idea;
    const fv = ctx.features.find((f) => f.symbol === idea.symbol);
    if (!fv) return null;
    const rule = personaIdeaToRule(idea, ctx.skillHash, ctx.personaCfg);
    const evidence: Record<string, number> = {};
    for (const ref of idea.refs) if (ref.kind === "feature") evidence[ref.feature] = ref.value;
    const plan = planTrade(
      { ruleId: rule.id, ruleHash: ctx.skillHash, symbol: idea.symbol, result: "triggered", evidence },
      rule, fv, ctx.plannerConfig, openTradeCount, ctx.breaker.tripped, ctx.dateUtc,
      ctx.liveClosedTradesForPersona, ctx.ladderResetByBreaker, ctx.instruments[idea.symbol] ?? null,
      ctx.report.decisionTime,
    );
    return { plan, rule, sourcePlan: null, sourceRule: null };
  }

  const sourceEntry = findReportPlanById(ctx.report, ctx.dateUtc, choice.planId);
  if (!sourceEntry || sourceEntry.kind !== "plan") return null;
  const sourcePlan = sourceEntry;
  const sourceRule = findSourceRule(sourcePlan, ctx);
  if (!sourceRule) return null;
  const fv = ctx.features.find((f) => f.symbol === sourcePlan.symbol);
  if (!fv) return null;
  const rule = reportPlanToPersonaRule(sourceRule, ctx.skillHash, ctx.personaCfg);
  const plan = planTrade(
    { ruleId: rule.id, ruleHash: ctx.skillHash, symbol: sourcePlan.symbol, result: "triggered", evidence: {} },
    rule, fv, ctx.plannerConfig, openTradeCount, ctx.breaker.tripped, ctx.dateUtc,
    ctx.liveClosedTradesForPersona, ctx.ladderResetByBreaker, ctx.instruments[sourcePlan.symbol] ?? null,
    ctx.report.decisionTime,
  );
  return { plan, rule, sourcePlan, sourceRule };
}

// ── validateDecision (§5.15, --mode plan) ───────────────────────────────────────────────────────

function conditionMalformed(cond: Condition): boolean {
  if (cond.op === "between") {
    return !Array.isArray(cond.value) || cond.value.length !== 2 ||
      !Number.isFinite(cond.value[0]) || !Number.isFinite(cond.value[1]) || cond.value[0] > cond.value[1];
  }
  return typeof cond.value !== "number" || !Number.isFinite(cond.value);
}

function refFailure(ref: AiEvidenceRef, ctx: DecisionContext): { code: "unverifiable_feature"; detail: string } | null {
  if (ref.kind !== "feature") return null;
  const fv = ctx.features.find((f) => f.symbol === ref.symbol);
  const val = fv?.features[ref.feature];
  if (!val || val.kind !== "value") {
    return { code: "unverifiable_feature", detail: `feature "${ref.feature}" for ${ref.symbol} is not available in today's features` };
  }
  const tolerance = FEATURE_TOLERANCE_ABS * Math.max(1, Math.abs(val.value));
  if (Math.abs(val.value - ref.value) > tolerance) {
    return { code: "unverifiable_feature", detail: `persona said ${ref.value}, system computed ${val.value}` };
  }
  return null;
}

/** Pure. Validates the input against the report and the config. Never throws; collects EVERY
 *  rejection (like parseRuleSet, §5.4) so one run tells the persona everything that is wrong. */
export function validateDecision(input: DailyDecisionInput, ctx: DecisionContext): DecisionValidation {
  const rejections: DecisionRejection[] = [];
  const unverifiedWebRefs: { path: string; url: string }[] = [];

  if (input.dateUtc !== ctx.dateUtc) {
    rejections.push(reject("date_mismatch", "dateUtc", `input.dateUtc "${input.dateUtc}" !== --date "${ctx.dateUtc}"`));
  }

  const planEntries = ctx.report.plans.filter((p): p is PlanRow => p.kind === "plan");
  const planIds = new Set(planEntries.map((p) => p.planId));

  const seenStancePlanIds = new Set<string>();
  input.stances.forEach((stance: PersonaStance, i) => {
    if (seenStancePlanIds.has(stance.planId)) {
      rejections.push(reject("duplicate_stance", stance.planId, `stances[${i}] duplicates an earlier stance for "${stance.planId}"`));
    } else {
      seenStancePlanIds.add(stance.planId);
    }
    if (!planIds.has(stance.planId)) {
      rejections.push(reject("unknown_plan", stance.planId, `stance references planId "${stance.planId}", not a kind:"plan" entry in today's report`));
    }
    if (!stance.reasons.some((r) => r.trim().length > 0)) {
      rejections.push(reject("empty_reason", `stances[${i}].reasons`, "stance has no non-empty reason"));
    }
  });
  for (const p of planEntries) {
    if (!seenStancePlanIds.has(p.planId)) {
      rejections.push(reject("missing_stance", p.planId, `no stance given for plan "${p.planId}"`));
    }
  }

  if (input.rationale.trim() === "") {
    rejections.push(reject("empty_reason", "rationale", "rationale must be non-empty"));
  }

  const choice = input.choice;
  let canAttemptPlan = false;

  if (choice.kind === "report-plan") {
    const target = findReportPlanById(ctx.report, ctx.dateUtc, choice.planId);
    if (!target) {
      rejections.push(reject("unknown_plan", "choice.planId", `no plan "${choice.planId}" in today's report`));
    } else if (target.kind !== "plan") {
      rejections.push(reject("not_a_plan", "choice.planId", `plan "${choice.planId}" is kind:"rejected"`));
    } else {
      if (ctx.now > target.expiresAt) {
        rejections.push(reject("expired", "choice.planId", `now (${ctx.now}) is after the plan's expiresAt (${target.expiresAt})`));
      }
      const sourceRule = findSourceRule(target, ctx);
      if (!sourceRule || ruleHash(sourceRule) !== target.ruleHash) {
        rejections.push(reject("rule_changed", "choice.planId", `source rule "${target.ruleId}" could not be reloaded, or its hash no longer matches the plan`));
      } else {
        canAttemptPlan = ctx.now <= target.expiresAt;
      }
    }
  } else if (choice.kind === "persona-idea") {
    const idea = choice.idea;
    if (idea.refs.length === 0) {
      rejections.push(reject("no_evidence", "choice.idea.refs", "idea has zero evidence refs"));
    } else if (!idea.refs.some((r) => r.kind === "feature")) {
      rejections.push(reject("web_only_evidence", "choice.idea.refs", "idea's only evidence is web reference(s) — never sufficient on their own"));
    }
    if (!ctx.configSymbols.includes(idea.symbol)) {
      rejections.push(reject("symbol_not_configured", "choice.idea.symbol", `"${idea.symbol}" is not in config.symbols`));
    }
    if (!(idea.confidence >= 0 && idea.confidence <= 1)) {
      rejections.push(reject("out_of_range", "choice.idea.confidence", "must be in [0,1]"));
    }
    if (!(idea.stopAtrMultiple > 0 && idea.stopAtrMultiple <= 10)) {
      rejections.push(reject("out_of_range", "choice.idea.stopAtrMultiple", "must be in (0,10]"));
    }
    if (!(idea.targetRMultiple > 0 && idea.targetRMultiple <= 20)) {
      rejections.push(reject("out_of_range", "choice.idea.targetRMultiple", "must be in (0,20]"));
    }
    if (!(Number.isInteger(idea.maxHoldDays) && idea.maxHoldDays >= 1 && idea.maxHoldDays <= 10)) {
      rejections.push(reject("out_of_range", "choice.idea.maxHoldDays", "must be an integer in 1..10"));
    }
    idea.invalidateWhenAny.forEach((cond, i) => {
      if (conditionMalformed(cond)) rejections.push(reject("out_of_range", `choice.idea.invalidateWhenAny[${i}]`, "malformed condition"));
    });
    idea.refs.forEach((ref, i) => {
      if (ref.kind === "web") {
        unverifiedWebRefs.push({ path: `choice.idea.refs[${i}]`, url: ref.url });
        return;
      }
      const failure = refFailure(ref, ctx);
      if (failure) rejections.push(reject(failure.code, `choice.idea.refs[${i}]`, failure.detail));
    });
    canAttemptPlan = ctx.configSymbols.includes(idea.symbol);
  } else {
    if (choice.reason.trim() === "") {
      rejections.push(reject("empty_reason", "choice.reason", "no-trade reason must be non-empty"));
    }
  }

  // replan_rejected: only attempted once the choice itself is otherwise clean — planTrade cannot
  // be meaningfully asked about an unknown plan, an expired one, or an out-of-range idea.
  if (rejections.length === 0 && choice.kind !== "no-trade" && canAttemptPlan) {
    const attempt = planFromChoice(choice, ctx);
    if (attempt && attempt.plan.kind === "rejected") {
      rejections.push(reject("replan_rejected", "choice", attempt.plan.reason));
    }
    // No expiry check on a persona idea: AC-105 deliberately lets a fresh idea carry its own
    // window (`decidedAt + executionWindowMs`) past the report plans' 12 h staleness, because the
    // idea is new even when the day's rule plans are stale. Only a `report-plan` choice inherits
    // that plan's expiry — see the branch above, and `buildOwnerProtocol`'s `capAt`.
  }

  return { ok: rejections.length === 0, rejections, unverifiedWebRefs };
}

// ── buildOwnerProtocol (§5.15) ───────────────────────────────────────────────────────────────────

function nextReportAtAfter(decidedAt: number): number {
  const dateStr = new Date(decidedAt).toISOString().slice(0, 10);
  let candidate = Date.parse(`${dateStr}T00:15:00Z`);
  while (candidate <= decidedAt) candidate += DAY_MS;
  return candidate;
}

/** Pure. Builds the owner protocol from the sized plan and config.
 *
 *  `capAt` is the chosen **report plan's** own `expiresAt` for a `report-plan` choice, and `null`
 *  for a `persona-idea` (AC-105: a fresh idea carries its own window even when the day's rule plans
 *  are already stale). When given, `executeUntil` is `min(decidedAt + executionWindowMs, capAt)`,
 *  per §13 A29 ("the owner may raise executionWindowMs up to the plan's expiresAt").
 *
 *  Without that cap a decision taken late in a plan's 12 h life advertised a window outliving the
 *  plan itself, and the journal accepted an entry against an expired plan: on 2026-09-18 a decision
 *  at 11:53 UTC printed 17:53 for a plan that expired at 12:15, and a paper entry was then recorded
 *  at 12:31 as if it were inside the window. */
export function buildOwnerProtocol(
  plan: PlanRow,
  atr14d: number,
  cfg: PersonaConfig,
  decidedAt: number,
  capAt: number | null = null,
): OwnerProtocol {
  const maxEntryGapAbs = cfg.maxEntryGapAtr * atr14d;
  const entryBand: [number, number] = [plan.referencePrice - maxEntryGapAbs, plan.referencePrice + maxEntryGapAbs];
  const isLong = plan.side === "long";

  const orders: OwnerProtocolOrder[] = [
    { slot: 1, kind: "entry", action: isLong ? "buy" : "sell", orderType: "market", price: null, quantity: plan.quantity, reduceOnly: false },
    { slot: 2, kind: "stop", action: isLong ? "sell" : "buy", orderType: "stop-market", price: plan.stopPrice, quantity: plan.quantity, reduceOnly: true },
    { slot: 3, kind: "take-profit", action: isLong ? "sell" : "buy", orderType: "limit", price: plan.targetPrice, quantity: plan.quantity, reduceOnly: true },
  ];

  return {
    decidedAt,
    executeFrom: decidedAt,
    executeUntil: capAt === null ? decidedAt + cfg.executionWindowMs : Math.min(decidedAt + cfg.executionWindowMs, capAt),
    referencePrice: plan.referencePrice,
    atr14d,
    maxEntryGapAbs,
    entryBand,
    venueIntent: plan.venueIntent,
    leverage: plan.leverage,
    marginMode: "isolated",
    orders,
    recordVia: plan.venueIntent === "paper" ? "paper-api" : "live-link",
    timeExitOnOrBefore: decidedAt + plan.maxHoldDays * DAY_MS,
    nextReportAt: nextReportAtAfter(decidedAt),
    ownerTimeZone: cfg.ownerTimeZone,
  };
}

// ── validateManage / validateReview (§5.15 "Manage and review modes") ───────────────────────────

/** Pure, same discipline as validateDecision: never throws, collects every rejection. */
export function validateManage(input: ManageInput, ctx: ManageContext): DecisionValidation {
  const rejections: DecisionRejection[] = [];

  if (input.dateUtc !== ctx.dateUtc || input.tradeId !== ctx.tradeArg) {
    rejections.push(reject("date_mismatch", "dateUtc", `input.dateUtc/tradeId must equal --date "${ctx.dateUtc}" / --trade "${ctx.tradeArg}"`));
  }

  if (ctx.trade === null) {
    rejections.push(reject("trade_not_found", "tradeId", `no journal trade with id "${ctx.tradeArg}"`));
    return { ok: false, rejections, unverifiedWebRefs: [] };
  }

  if (ctx.trade.status !== "open") {
    rejections.push(reject("trade_not_open", "tradeId", `trade "${ctx.trade.id}" status is "${ctx.trade.status}", not "open"`));
  }
  if (ctx.trade.plannedSnapshot === null) {
    rejections.push(reject("trade_not_planned", "tradeId", `trade "${ctx.trade.id}" has no plannedSnapshot (unplanned fill)`));
  }
  if (input.thesis !== ctx.computedThesis) {
    rejections.push(reject("thesis_mismatch", "thesis", `persona said ${input.thesis}, system computed ${ctx.computedThesis}`));
  }

  if (input.action.kind === "tighten-stop") {
    const price = input.action.price;
    if (!Number.isFinite(price)) {
      rejections.push(reject("schema_invalid", "action.price", "tighten-stop price must be a finite number"));
    } else if (ctx.trade.plannedSnapshot !== null) {
      const plan = ctx.trade.plannedSnapshot;
      const ok = plan.side === "long"
        ? plan.stopPrice < price && price < plan.referencePrice
        : plan.referencePrice < price && price < plan.stopPrice;
      if (!ok) {
        rejections.push(reject("out_of_range", "action.price", "tighten-stop price must move the stop toward entry, without crossing it"));
      }
    }
  } else if (input.action.kind !== "hold" && input.action.kind !== "close-now") {
    rejections.push(reject("schema_invalid", "action.kind", 'must be one of "hold", "tighten-stop", "close-now"'));
  }

  if (!input.reasons.some((r) => r.trim().length > 0)) {
    rejections.push(reject("empty_reason", "reasons", "reasons must include at least one non-empty string"));
  }

  return { ok: rejections.length === 0, rejections, unverifiedWebRefs: [] };
}

const THESIS_VERDICTS = ["confirmed", "invalidated", "inconclusive"] as const;

export function validateReview(input: ReviewInput, ctx: ReviewContext): DecisionValidation {
  const rejections: DecisionRejection[] = [];

  if (input.dateUtc !== ctx.dateUtc || input.tradeId !== ctx.tradeArg) {
    rejections.push(reject("date_mismatch", "dateUtc", `input.dateUtc/tradeId must equal --date "${ctx.dateUtc}" / --trade "${ctx.tradeArg}"`));
  }

  if (ctx.trade === null) {
    rejections.push(reject("trade_not_found", "tradeId", `no journal trade with id "${ctx.tradeArg}"`));
    return { ok: false, rejections, unverifiedWebRefs: [] };
  }
  if (ctx.trade.status !== "closed") {
    rejections.push(reject("trade_not_closed", "tradeId", `trade "${ctx.trade.id}" status is "${ctx.trade.status}", not "closed"`));
  }

  const computed = ctx.computed;
  if (computed !== null) {
    const rMultipleOk = computed.rMultiple !== null && Math.abs(input.rMultiple - computed.rMultiple) <= 1e-6;
    if (!rMultipleOk) {
      rejections.push(reject("out_of_range", "rMultiple", `persona said ${input.rMultiple}, system computed ${computed.rMultiple}`));
    }
    if (input.exitKind !== computed.exitKind) {
      rejections.push(reject("out_of_range", "exitKind", `persona said "${input.exitKind}", system computed "${computed.exitKind}"`));
    }
    if (input.followedPlan !== computed.followedPlan) {
      rejections.push(reject("out_of_range", "followedPlan", `persona said ${input.followedPlan}, system computed ${computed.followedPlan}`));
    }
  }

  if (!(THESIS_VERDICTS as readonly string[]).includes(input.thesisVerdict)) {
    rejections.push(reject("schema_invalid", "thesisVerdict", `must be one of ${THESIS_VERDICTS.join(", ")}`));
  }
  if (input.lesson.trim() === "") {
    rejections.push(reject("empty_reason", "lesson", "lesson must be non-empty"));
  }

  return { ok: rejections.length === 0, rejections, unverifiedWebRefs: [] };
}

// ── Shape (schema) validators — see file header spec-gap note ───────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
const AI_STANCES = ["support", "caution", "oppose"] as const;
const NEWS_TAGS = ["confirmed", "unconfirmed", "contradicts"] as const;
const EXIT_KINDS = ["stop", "target", "time", "thesis_invalidated", "discretionary", "liquidation", "unknown"] as const;

function isConditionShape(v: unknown): v is Condition {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c["feature"] !== "string" || typeof c["op"] !== "string") return false;
  if (c["op"] === "between") {
    return Array.isArray(c["value"]) && c["value"].length === 2 && c["value"].every((x) => typeof x === "number");
  }
  return typeof c["value"] === "number";
}

function isNewsItemShape(v: unknown): v is PersonaNewsItem {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return typeof n["title"] === "string" && typeof n["url"] === "string" &&
    (n["date"] === null || typeof n["date"] === "string") &&
    (NEWS_TAGS as readonly string[]).includes(n["tag"] as string);
}

function isEvidenceRefShape(v: unknown): v is AiEvidenceRef {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r["kind"] === "web") return typeof r["url"] === "string";
  if (r["kind"] === "feature") return typeof r["symbol"] === "string" && typeof r["feature"] === "string" && typeof r["value"] === "number";
  return false;
}

function isPersonaIdeaShape(v: unknown): v is PersonaIdea {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  return typeof i["symbol"] === "string" &&
    (i["side"] === "long" || i["side"] === "short") &&
    typeof i["thesis"] === "string" &&
    Array.isArray(i["catalysts"]) && i["catalysts"].every((c) => typeof c === "string") &&
    Array.isArray(i["refs"]) && i["refs"].every(isEvidenceRefShape) &&
    Array.isArray(i["invalidateWhenAny"]) && i["invalidateWhenAny"].every(isConditionShape) &&
    typeof i["stopAtrMultiple"] === "number" && typeof i["targetRMultiple"] === "number" &&
    typeof i["maxHoldDays"] === "number" && typeof i["confidence"] === "number";
}

function isPersonaChoiceShape(v: unknown): v is PersonaChoice {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (c["kind"] === "report-plan") return typeof c["planId"] === "string";
  if (c["kind"] === "persona-idea") return isPersonaIdeaShape(c["idea"]);
  if (c["kind"] === "no-trade") return typeof c["reason"] === "string";
  return false;
}

/** See file header: schema-shape validation for the JSON block on stdin, mirroring
 *  parseRuleSet's `unknown -> typed | issues`. Only reports `schema_invalid` — one rejection is
 *  enough, since a malformed block can't be meaningfully checked field-by-field further. */
export function parseDailyDecisionInput(raw: unknown): DailyDecisionInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["dateUtc"]) || !isPersonaChoiceShape(r["choice"])) return null;
  if (!Array.isArray(r["stances"])) return null;
  for (const s of r["stances"]) {
    if (typeof s !== "object" || s === null) return null;
    const st = s as Record<string, unknown>;
    if (typeof st["planId"] !== "string" || !(AI_STANCES as readonly string[]).includes(st["stance"] as string)) return null;
    if (!Array.isArray(st["reasons"]) || !st["reasons"].every((x) => typeof x === "string")) return null;
  }
  if (!Array.isArray(r["news"]) || !r["news"].every(isNewsItemShape)) return null;
  if (typeof r["rationale"] !== "string") return null;
  return raw as DailyDecisionInput;
}

export function parseManageInput(raw: unknown): ManageInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["dateUtc"]) || !isNonEmptyString(r["tradeId"])) return null;
  const action = r["action"] as Record<string, unknown> | undefined;
  if (!action || typeof action !== "object") return null;
  if (action["kind"] === "tighten-stop") {
    if (typeof action["price"] !== "number") return null;
  } else if (action["kind"] !== "hold" && action["kind"] !== "close-now") {
    return null;
  }
  if (typeof r["thesis"] !== "string" || !["intact", "invalidated", "not_evaluable"].includes(r["thesis"])) return null;
  if (!Array.isArray(r["reasons"]) || !r["reasons"].every((x) => typeof x === "string")) return null;
  if (!Array.isArray(r["news"]) || !r["news"].every(isNewsItemShape)) return null;
  return raw as ManageInput;
}

export function parseReviewInput(raw: unknown): ReviewInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["dateUtc"]) || !isNonEmptyString(r["tradeId"])) return null;
  if (!isFiniteNumber(r["rMultiple"])) return null;
  if (!(EXIT_KINDS as readonly string[]).includes(r["exitKind"] as string)) return null;
  if (typeof r["followedPlan"] !== "boolean") return null;
  if (!["confirmed", "invalidated", "inconclusive"].includes(r["thesisVerdict"] as string)) return null;
  if (typeof r["lesson"] !== "string") return null;
  return raw as ReviewInput;
}
