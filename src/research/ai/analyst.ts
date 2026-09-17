// AI analyst orchestration — specs/daily-catalyst-manual-trading.md §5.13, §4.15.
//
// Three exported pieces, all pure except `runAiAnalyst` (which does I/O only through its
// injected `port` and the ledger/rule-persistence side effects §5.13 requires):
//  - `promptVersionHash` / `aiIdeaToRule`: pure helpers, verbatim from §5.13's doc comments.
//  - `buildAiAnalystInput`: assembles `AiAnalystInput` from the day's report/features/journal —
//    this is §4.15's "build AiAnalystInput from the day's snapshot, rule outcomes, rule plans and
//    open trades" step, split out from `runAiAnalyst` so the latter's signature can match §5.13's
//    literal `runAiAnalyst(input, port, cfg, planner)` transcription exactly.
//  - `runAiAnalyst`: budget check -> port.analyze -> ledger append -> verify -> plan.
//
// Spec gap resolved here (like src/research/planner.ts's `maxOpenManualTrades` gap, see that
// file's header): §5.13's `runAiAnalyst` planner bag, as transcribed, has no way for this module
// to get exchange lot-size filters or a ai-rules root directory, yet building a plan for an AI
// idea calls the exact same `planTrade` the rules channel uses, which requires an
// `InstrumentFilter | null` per symbol (src/research/planner.ts), and persisting each AI rule
// write-once (§5.13) needs a root directory tests can redirect. Both are added as extra fields
// on the `planner` bag (`instruments`, `aiRulesRoot`) rather than invented as new positional
// parameters — the smallest change that makes the function well-defined, exactly the reasoning
// planner.ts's header applies to its own analogous gap.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RuleDefinition, RuleOutcome, ThesisState } from "../rules.ts";
import type { FeatureVector } from "../types.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "../planner.ts";
import { planTrade } from "../planner.ts";
import type { ManualTrade } from "../../journal/types.ts";
import { firstEntryTime } from "../../journal/trade-analytics.ts";
import { appendLedgerLine, estimateCallCostUsd, monthToDateSpendUsd } from "./budget.ts";
import type {
  AiAnalystConfig, AiAnalystInput, AiAnalystSection, AiClientPort, AiIdea, AiRejectedItem,
} from "./types.ts";
import { verifyAiOutput } from "./verify.ts";

const HOUR_MS = 60 * 60 * 1000;

// ── promptVersionHash ────────────────────────────────────────────────────────────────────────

/** Recursively sorts object keys (array order preserved) — copied in spirit from
 *  src/research/rules.ts's `canonicalize` (not imported: that one is module-private, and this
 *  hash's input shape is unrelated to a RuleDefinition). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 over canonical JSON of every setting that changes AI behaviour (§5.13). Budget,
 *  pricing, timeout, channelStatus and passedPromptHash are deliberately excluded. */
export function promptVersionHash(systemPrompt: string, outputJsonSchema: string, cfg: AiAnalystConfig): string {
  const canonical = canonicalize({
    systemPrompt,
    outputJsonSchema,
    model: cfg.model,
    effort: cfg.effort,
    maxTokens: cfg.maxTokens,
    webSearchMaxUses: cfg.webSearchMaxUses,
    maxIdeasPerDay: cfg.maxIdeasPerDay,
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ── aiIdeaToRule ─────────────────────────────────────────────────────────────────────────────

/** Pure. §5.13: origin "ai-analyst", forwardOnly true, entryWhenAll [], evidence [], version 1,
 *  id `ai-analyst-<hash8>`; status "paper-passed" only when the channel has passed D1 for this
 *  exact prompt hash, else "experimental" (AC-46). */
export function aiIdeaToRule(idea: AiIdea, promptHash: string, cfg: AiAnalystConfig): RuleDefinition {
  const status: RuleDefinition["status"] =
    cfg.channelStatus === "paper-passed" && cfg.passedPromptHash === promptHash ? "paper-passed" : "experimental";
  return {
    id: `ai-analyst-${promptHash.slice(0, 8)}`,
    version: 1,
    description: idea.thesis,
    evidence: [],
    status,
    symbols: [idea.symbol],
    side: idea.side,
    entryWhenAll: [],
    invalidateWhenAny: idea.invalidateWhenAny,
    stopAtrMultiple: idea.stopAtrMultiple,
    targetRMultiple: idea.targetRMultiple,
    maxHoldDays: idea.maxHoldDays,
    forwardOnly: true,
    origin: "ai-analyst",
  };
}

// ── buildAiAnalystInput ──────────────────────────────────────────────────────────────────────

/** Assembles `AiAnalystInput` from the pieces `research:daily` already has by the time the rules
 *  report is written (§4.15). `unrealisedR` is always null: research:daily has no live position
 *  feed (only the journal server's exchange sync does), so an open trade's unrealised R can't be
 *  computed here — documented limitation, not an oversight. */
export function buildAiAnalystInput(params: {
  dateUtc: string;
  decisionTime: number;
  promptVersionHash: string;
  systemPrompt: string;
  sources: AiAnalystInput["sources"];
  features: FeatureVector[];
  outcomes: RuleOutcome[];
  rulePlans: TradePlan[]; // origin "rules-file" only
  configSymbols: string[];
  openTrades: readonly ManualTrade[];
  openTradeThesis: readonly { tradeId: string; ruleId: string; state: ThesisState }[];
  now: number;
}): AiAnalystInput {
  const thesisByTradeId = new Map(params.openTradeThesis.map((t) => [t.tradeId, t.state]));
  return {
    dateUtc: params.dateUtc,
    decisionTime: params.decisionTime,
    promptVersionHash: params.promptVersionHash,
    systemPrompt: params.systemPrompt,
    sources: params.sources,
    features: params.features,
    outcomes: params.outcomes,
    rulePlans: params.rulePlans,
    configSymbols: params.configSymbols,
    openTrades: params.openTrades.map((t) => ({
      tradeId: t.id,
      symbol: t.symbol,
      side: t.side,
      ruleId: t.ruleId,
      thesis: thesisByTradeId.get(t.id) ?? "not_evaluable",
      heldHours: (params.now - firstEntryTime(t)) / HOUR_MS,
      unrealisedR: null,
    })),
  };
}

// ── runAiAnalyst ─────────────────────────────────────────────────────────────────────────────

function emptySection(status: AiAnalystSection["status"], reason: string, model: string | null): AiAnalystSection {
  return {
    status, reason, model, servedByModel: null, promptVersionHash: null,
    costUsd: 0, monthToDateUsd: 0, regimeSummary: null,
    assessments: [], plans: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], rejected: [],
  };
}

/** Write-once, mirroring src/research/snapshot-store.ts's pattern: `wx` refuses to clobber an
 *  existing file. Persisted so a later report can run `evaluateThesis` on an open AI-origin trade
 *  (§5.13; a missing file makes that trade's thesis `not_evaluable`, AC-53). */
function persistAiRuleOnce(aiRulesRoot: string, planId: string, rule: RuleDefinition): void {
  const path = join(aiRulesRoot, `${planId}.json`);
  if (existsSync(path)) return; // already persisted by an earlier run for this exact planId
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(rule, null, 2)}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** Orchestrates: budget check -> analyze -> append ledger line (even on failure, when usage is
 *  known) -> verify -> dedupe by symbol -> plan ideas. Never throws for API/verification/ledger/
 *  persistence problems (§5.13, "MUST resolve, never throws") — every early return below,
 *  including a ledger-write or ai-rule-persistence failure, is a `status: "unavailable"` or
 *  `"skipped_budget"` section, never a rejected promise. */
export async function runAiAnalyst(
  input: AiAnalystInput,
  port: AiClientPort,
  cfg: AiAnalystConfig,
  planner: {
    cfg: PlannerConfig;
    openTradeCount: number;
    breakerTripped: boolean;
    dateUtc: string;
    features: FeatureVector[];
    liveClosedTradesForAi: number;
    ladderResetByBreaker: boolean;
    ledgerPath: string;
    now: number;
    /** Gap resolution — see file header. */
    instruments: Record<string, InstrumentFilter | null>;
    /** Gap resolution — see file header. Default "data/ai-rules". */
    aiRulesRoot: string;
  },
): Promise<AiAnalystSection> {
  let monthToDateBefore: number;
  try {
    monthToDateBefore = monthToDateSpendUsd(planner.ledgerPath, planner.now);
  } catch (err) {
    return emptySection("unavailable", `ledger_unreadable: ${(err as Error).message}`, cfg.model);
  }
  if (monthToDateBefore >= cfg.monthlyBudgetUsd) {
    const section = emptySection(
      "skipped_budget",
      `month-to-date spend $${monthToDateBefore.toFixed(2)} >= budget $${cfg.monthlyBudgetUsd.toFixed(2)}`,
      cfg.model,
    );
    section.monthToDateUsd = monthToDateBefore;
    return section;
  }

  const result = await port.analyze(input);

  if (result.usage !== null) {
    const costUsd = estimateCallCostUsd(result.usage, cfg);
    try {
      appendLedgerLine(planner.ledgerPath, {
        time: planner.now, dateUtc: planner.dateUtc, model: cfg.model, usage: result.usage, costUsd,
        resultKind: result.kind,
      });
    } catch (err) {
      // Fail closed (§5.13 "MUST resolve, never throws"): an unrecorded call is a budget-tracking
      // integrity problem, not something to paper over by proceeding as if it succeeded.
      const section = emptySection("unavailable", `ledger_write_failed: ${(err as Error).message}`, cfg.model);
      section.promptVersionHash = input.promptVersionHash;
      return section;
    }
  }
  const monthToDateUsd = result.usage !== null ? monthToDateBefore + estimateCallCostUsd(result.usage, cfg) : monthToDateBefore;

  if (result.kind === "failed") {
    const section = emptySection("unavailable", `${result.reason}: ${result.detail}`, cfg.model);
    section.promptVersionHash = input.promptVersionHash;
    section.monthToDateUsd = monthToDateUsd;
    return section;
  }

  const costUsd = estimateCallCostUsd(result.usage, cfg);
  const verified = verifyAiOutput(result.output, input, result.webResults, cfg.maxIdeasPerDay);
  const rejected: AiRejectedItem[] = [...verified.rejected];

  // Two verified ideas sharing a symbol: keep the first, drop the rest (§5.13).
  const seenSymbols = new Set<string>();
  const dedupedIdeas: AiIdea[] = [];
  verified.output.ideas.forEach((idea, i) => {
    if (seenSymbols.has(idea.symbol)) {
      rejected.push({ path: `ideas[${i}]`, reason: "over_limit" });
      return;
    }
    seenSymbols.add(idea.symbol);
    dedupedIdeas.push(idea);
  });

  const plans: TradePlan[] = [];
  const usedIdeas: AiIdea[] = [];
  for (const idea of dedupedIdeas) {
    const fv = planner.features.find((f) => f.symbol === idea.symbol);
    if (!fv) continue; // symbol_not_configured would already have dropped this in verify; defensive only
    const rule = aiIdeaToRule(idea, input.promptVersionHash, cfg);
    const evidence: Record<string, number> = {};
    for (const ref of idea.refs) if (ref.kind === "feature") evidence[ref.feature] = ref.value;
    const outcome: Extract<RuleOutcome, { result: "triggered" }> = {
      ruleId: rule.id, ruleHash: input.promptVersionHash, symbol: idea.symbol, result: "triggered", evidence,
    };
    const plan = planTrade(
      outcome, rule, fv, planner.cfg, planner.openTradeCount, planner.breakerTripped, planner.dateUtc,
      planner.liveClosedTradesForAi, planner.ladderResetByBreaker, planner.instruments[idea.symbol] ?? null,
      input.decisionTime,
    );
    if (plan.kind === "plan") {
      planner.openTradeCount += 1;
      try {
        persistAiRuleOnce(planner.aiRulesRoot, plan.planId, rule);
      } catch (err) {
        // Fail closed: a plan whose rule couldn't be persisted must not be returned as if
        // nothing went wrong — a later evaluateThesis for its open trade would have no rule to
        // load anyway (AC-53's "not_evaluable" path is for a missing file, not a write failure
        // this run silently swallowed). Abort the whole section rather than a partial one.
        const section = emptySection("unavailable", `ai_rule_persist_failed: ${(err as Error).message}`, cfg.model);
        section.promptVersionHash = input.promptVersionHash;
        section.monthToDateUsd = monthToDateUsd;
        return section;
      }
    }
    plans.push(plan);
    usedIdeas.push(idea);
  }

  return {
    status: "ok",
    reason: "",
    model: cfg.model,
    servedByModel: result.servedByModel,
    promptVersionHash: input.promptVersionHash,
    costUsd,
    monthToDateUsd,
    regimeSummary: verified.output.regimeSummary,
    assessments: verified.output.planAssessments,
    plans,
    ideas: usedIdeas,
    openTradeNotes: verified.output.openTradeNotes,
    risks: verified.output.risks,
    dataGaps: verified.output.dataGaps,
    rejected,
  };
}
