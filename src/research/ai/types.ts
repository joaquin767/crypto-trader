// AI analyst types — specs/daily-catalyst-manual-trading.md §5.13.
//
// Originally a Phase 2 stub (types only) so src/journal/types.ts (ManualTrade.aiStanceAtPlan)
// and src/research/report.ts (DailyReport.aiAnalyst) could compile against their final shape
// ahead of time (§9 Phase 2 row). Phase 4b adds the port/input/result types the AI analyst
// itself needs (client, verification, promptVersionHash, aiIdeaToRule, runAiAnalyst — all in
// src/research/ai/analyst.ts, src/research/ai/verify.ts, src/research/ai/anthropic-client.ts).
// This file stays free of `@anthropic-ai/sdk`/`zod` imports (gate §12.10 — see
// src/research/ai/output-schema.ts and src/research/ai/anthropic-client.ts for those).

import type { Condition, RuleOutcome, ThesisState } from "../rules.ts";
import type { FeatureName, FeatureVector, SourceStatus } from "../types.ts";
import type { TradePlan } from "../planner.ts";

export type AiStance = "support" | "caution" | "oppose";

export type AiEvidenceRef =
  | { kind: "feature"; symbol: string; feature: FeatureName; value: number } // value must match the FeatureVector
  | { kind: "web"; url: string }; // url must appear in this call's search results

export interface AiPlanAssessment {
  planId: string;
  stance: AiStance;
  confidence: number;
  reasons: { text: string; refs: AiEvidenceRef[] }[];
}

export interface AiIdea {
  symbol: string;
  side: "long" | "short";
  thesis: string;
  catalysts: string[];
  refs: AiEvidenceRef[];
  invalidateWhenAny: Condition[];
  stopAtrMultiple: number;
  targetRMultiple: number;
  maxHoldDays: number;
  confidence: number;
}

/** Exact shape requested via structured outputs (JSON schema generated from a zod schema, §10.1). */
export interface AiAnalystOutput {
  regimeSummary: string;
  planAssessments: AiPlanAssessment[];
  ideas: AiIdea[];
  openTradeNotes: { tradeId: string; note: string; refs: AiEvidenceRef[] }[];
  risks: string[];
  dataGaps: string[];
}

export interface AiRejectedItem {
  path: string; // e.g. "ideas[1]", "planAssessments[0].reasons[2]"
  reason:
    | "unverifiable_feature" | "unverifiable_web" | "unknown_plan" | "unknown_trade" | "symbol_not_configured"
    | "out_of_range" | "over_limit" | "no_evidence";
}

export interface AiAnalystSection {
  status: "pending" | "ok" | "unavailable" | "skipped_budget" | "disabled";
  // "pending": written by buildReport when ai.enabled, before the AI call; replaced by
  // attachAiAnalyst. A report left "pending" means the process died mid-run; the Markdown then
  // shows "AI analyst: did not complete".
  reason: string; // empty only when status is "ok"
  model: string | null;
  servedByModel: string | null;
  promptVersionHash: string | null;
  costUsd: number;
  monthToDateUsd: number;
  regimeSummary: string | null;
  assessments: AiPlanAssessment[]; // verified only
  plans: TradePlan[]; // origin "ai-analyst", produced by planTrade from aiIdeaToRule(...)
  ideas: AiIdea[]; // verified ideas, index-aligned with the planTrade calls
  openTradeNotes: AiAnalystOutput["openTradeNotes"];
  risks: string[];
  dataGaps: string[];
  rejected: AiRejectedItem[];
}

/** Input to one AI analyst call, built by src/research/ai/analyst.ts's
 *  `buildAiAnalystInput` from the day's report/features/journal. `sources`/`features`/
 *  `outcomes` mirror `DailyReport`'s own shapes without importing report.ts (which itself
 *  imports this file — see file header). `rulePlans` is origin "rules-file" only. */
export interface AiAnalystInput {
  dateUtc: string;
  decisionTime: number;
  promptVersionHash: string;
  systemPrompt: string;
  sources: { sourceId: string; status: SourceStatus; statusDetail: string; fetchedAt: number; sha256: string }[];
  features: FeatureVector[];
  outcomes: RuleOutcome[];
  rulePlans: TradePlan[]; // origin "rules-file" only
  openTrades: {
    tradeId: string;
    symbol: string;
    side: "long" | "short";
    ruleId: string | null;
    thesis: ThesisState;
    heldHours: number;
    unrealisedR: number | null;
  }[];
  configSymbols: string[];
}

export type AiCallResult =
  | {
      kind: "ok";
      output: AiAnalystOutput;
      webResults: { url: string; title: string; pageAge: string | null }[];
      usage: { inputTokens: number; outputTokens: number; webSearchRequests: number };
      servedByModel: string;
      rawResponsePath: string;
    }
  | {
      kind: "failed";
      reason: "no_api_key" | "api_error" | "rate_limited" | "timeout" | "refusal" | "max_tokens" | "schema_invalid";
      detail: string;
      usage: { inputTokens: number; outputTokens: number; webSearchRequests: number } | null;
    };

/** Port. Implementations MUST resolve (never reject) — see src/research/ai/anthropic-client.ts. */
export interface AiClientPort {
  analyze(input: AiAnalystInput): Promise<AiCallResult>;
}

export interface AiAnalystConfig {
  enabled: boolean; // default false until the owner turns it on
  model: string; // default "claude-opus-5"
  effort: "low" | "medium" | "high" | "xhigh" | "max"; // default "high"
  maxTokens: number; // default 32000 (request is streamed)
  webSearchMaxUses: number; // integer 0..10, default 5; 0 disables the web search tool
  maxIdeasPerDay: number; // integer 0..3, default 3
  monthlyBudgetUsd: number; // > 0, default 15
  inputUsdPerMTok: number; // default 5    (claude-opus-5 list price, cached 2026-06-24)
  outputUsdPerMTok: number; // default 25
  webSearchUsdPerRequest: number; // default 0.01 — UNVERIFIED, owner confirms at implementation (§13 A16)
  channelStatus: "experimental" | "paper-passed"; // owner-edited after Gate D1 for the AI channel (§8.4)
  passedPromptHash: string | null; // the full promptVersionHash that passed D1; required non-null when channelStatus is "paper-passed"
  timeoutMs: number; // default 600_000
}
