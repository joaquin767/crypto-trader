// Persona decision channel — specs/daily-catalyst-manual-trading.md §5.15 (revision 3, Phase 6).
//
// The persona (§4.7) decides; this module validates, sizes, records and renders. Nothing here
// calls the network or an LLM: the persona is a human-driven Claude Code session, and its output
// reaches the system only as a JSON block on stdin. `npm run decide` is the only writer of
// `data/decisions/` and `reports/*.decision.md` (P9).

import type { AiEvidenceRef, AiStance } from "../research/ai/types.ts";
import type { Condition, RuleDefinition, RuleSet, ThesisState } from "../research/rules.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "../research/planner.ts";
import type { DailyReport } from "../research/report.ts";
import type { FeatureVector } from "../research/types.ts";
import type { ExitKind, ManualTrade } from "../journal/types.ts";
import type { ClosedTradeReview } from "../journal/trade-analytics.ts";
import { fetchKlines } from "../journal/market-data.ts";
import type { PersonaConfig } from "../config.ts";

/** A news item the persona checked. Recorded, never verified by the system (P3, revision 3). */
export interface PersonaNewsItem {
  title: string;
  url: string;
  date: string | null;
  tag: "confirmed" | "unconfirmed" | "contradicts";
}

/** The persona's opinion of ONE plan in the report. One is required for every kind:"plan" plan. */
export interface PersonaStance {
  planId: string;
  stance: AiStance;
  reasons: string[]; // >= 1 non-empty string
}

/** Same shape as AiIdea (§5.13) — deliberately, so both non-rule channels are sized by one code path. */
export interface PersonaIdea {
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

export type PersonaChoice =
  | { kind: "report-plan"; planId: string } // a kind:"plan" plan of that date's report, either channel
  | { kind: "persona-idea"; idea: PersonaIdea } // the persona's own idea
  | { kind: "no-trade"; reason: string }; // trimmed length >= 1

export interface DailyDecisionInput {
  dateUtc: string; // YYYY-MM-DD, must equal --date
  choice: PersonaChoice;
  stances: PersonaStance[]; // exactly one per kind:"plan" plan in that date's report, any order
  news: PersonaNewsItem[]; // may be empty ("News: not checked")
  rationale: string; // trimmed length >= 1; rendered as Plan Report §3
}

export type DecisionRejectionCode =
  | "schema_invalid" | "date_mismatch" | "unknown_plan" | "not_a_plan" | "expired" | "rule_changed"
  | "unverifiable_feature" | "web_only_evidence" | "no_evidence" | "symbol_not_configured"
  | "out_of_range" | "missing_stance" | "duplicate_stance" | "empty_reason" | "replan_rejected"
  // --mode manage / --mode review only. One code per distinguishable cause, so a rejection says
  // what to do:
  | "trade_not_found" // no journal trade with that id at all
  | "trade_not_open" // --mode manage, trade exists but status !== "open"
  | "trade_not_closed" // --mode review, trade exists but status !== "closed"
  | "trade_not_planned" // trade exists in the right state but has no plannedSnapshot (unplanned fill)
  | "thesis_mismatch"; // --mode manage, input.thesis !== the ThesisState the CLI computed
// `not_a_plan` is plan-mode only (the chosen report entry is `kind:"rejected"`); manage/review use
// the four trade-state codes above instead, so "not a plan" never has to mean four different things.

export interface DecisionRejection {
  code: DecisionRejectionCode;
  path: string;
  detail: string;
}

export interface DecisionValidation {
  ok: boolean;
  rejections: DecisionRejection[];
  /** Web refs are recorded, never verified: the persona's searches happen in its own session and
   *  the system cannot see them (P3). Always `verified: false`; present so the Plan Report §6 can
   *  list them. */
  unverifiedWebRefs: { path: string; url: string }[];
}

export interface OwnerProtocolOrder {
  slot: 1 | 2 | 3;
  kind: "entry" | "stop" | "take-profit";
  action: "buy" | "sell";
  orderType: "market" | "stop-market" | "limit";
  price: number | null;
  quantity: number;
  reduceOnly: boolean;
}

export interface OwnerProtocol {
  decidedAt: number;
  executeFrom: number; // = decidedAt
  executeUntil: number; // decidedAt + persona.executionWindowMs
  referencePrice: number;
  atr14d: number;
  maxEntryGapAbs: number; // persona.maxEntryGapAtr × atr14d
  entryBand: [number, number]; // [referencePrice − maxEntryGapAbs, referencePrice + maxEntryGapAbs]
  venueIntent: "paper" | "live";
  leverage: number;
  marginMode: "isolated";
  orders: OwnerProtocolOrder[]; // exactly 3, slots 1..3, stop and take-profit reduceOnly true
  recordVia: "paper-api" | "live-link"; // "paper-api" iff venueIntent "paper"
  timeExitOnOrBefore: number; // decidedAt + maxHoldDays × 24 h — the hard time exit, planning estimate from decidedAt
  nextReportAt: number; // next <date>T00:15:00Z strictly after decidedAt
  ownerTimeZone: string; // persona.ownerTimeZone, for the Plan Report's second clock
}

export interface DailyDecision {
  schemaVersion: 1;
  dateUtc: string;
  revision: number; // 0 for <date>.json, n for <date>.r<n>.json
  decidedAt: number;
  skillHash: string;
  reportPath: string;
  reportSha256: string;
  reportDecisionTime: number;
  input: DailyDecisionInput;
  validation: DecisionValidation;
  plan: Extract<TradePlan, { kind: "plan" }> | null; // null iff choice.kind === "no-trade"
  /** The synthesized persona rule (personaIdeaToRule / reportPlanToPersonaRule) that produced
   *  `plan`. Persisted here — not in data/ai-rules/ — so a later report can run `evaluateThesis`
   *  on an open persona-origin trade and so the plan is reproducible from the artifact alone.
   *  Null iff plan is null; a decision file that cannot be read makes that trade's thesis
   *  `not_evaluable` (same rule as §5.13). */
  personaRule: RuleDefinition | null;
  basedOnPlanId: string | null;
  basedOnRuleKey: string | null; // non-null iff choice.kind === "report-plan"
  ownerProtocol: OwnerProtocol | null; // null iff plan is null
  ownerTimeZone: string; // persona.ownerTimeZone at decide time — present on every decision, no-trade included, so the Plan Report's second clock column never falls back to UTC
  disclaimer: "Generated analysis for the owner's review. Not investment advice.";
}

// Manage and review artifacts are keyed by (dateUtc, tradeId), never by date alone: with
// `maxOpenManualTrades` up to 5 the owner can hold several positions at once, and two trades
// managed on the same morning are unrelated records. `tradeId` is therefore part of each
// artifact's identity, and write-once, `--revise` and "effective artifact" are all scoped to that
// pair (see the artifact table).
export interface ManageInput {
  dateUtc: string;
  tradeId: string; // must equal --date and --trade
  action: { kind: "hold" } | { kind: "tighten-stop"; price: number } | { kind: "close-now" };
  thesis: ThesisState;
  reasons: string[]; // >= 1 non-empty string
  news: PersonaNewsItem[];
}
export interface ManageDecision {
  schemaVersion: 1;
  dateUtc: string;
  tradeId: string;
  revision: number;
  writtenAt: number;
  skillHash: string;
  input: ManageInput;
  validation: DecisionValidation;
  tradePlanId: string | null;
  currentStopPrice: number;
  disclaimer: DailyDecision["disclaimer"];
}

export interface ReviewInput {
  dateUtc: string;
  tradeId: string; // must equal --date and --trade
  rMultiple: number;
  exitKind: ExitKind;
  followedPlan: boolean;
  thesisVerdict: "confirmed" | "invalidated" | "inconclusive";
  lesson: string; // trimmed length >= 1
}
export interface ReviewDecision {
  schemaVersion: 1;
  dateUtc: string;
  tradeId: string;
  revision: number;
  writtenAt: number;
  skillHash: string;
  input: ReviewInput;
  validation: DecisionValidation;
  computed: ClosedTradeReview;
  disclaimer: DailyDecision["disclaimer"];
}

// ── Contexts consumed by validateDecision / validateManage / validateReview (§5.15) ─────────────

export interface DecisionContext {
  dateUtc: string;
  report: DailyReport;
  reportPath: string;
  reportSha256: string;
  features: FeatureVector[]; // rebuilt from that date's snapshots at the report's decisionTime
  configSymbols: readonly string[];
  plannerConfig: PlannerConfig;
  personaCfg: PersonaConfig;
  skillHash: string;
  ruleSet: RuleSet; // research-rules.json, to re-load a chosen rule plan's rule
  aiRules: Record<string, RuleDefinition>; // data/ai-rules/<planId>.json, to re-load a chosen AI plan's rule
  journal: readonly ManualTrade[];
  breaker: { tripped: boolean; trigger: string | null; details: string };
  liveClosedTradesForPersona: number;
  ladderResetByBreaker: boolean;
  instruments: Record<string, InstrumentFilter | null>;
  now: number; // = decidedAt
}

export interface ManageContext {
  dateUtc: string;
  tradeArg: string; // --trade, as given on the command line
  trade: ManualTrade | null; // journal lookup by id; null = not found
  /** The thesis the CLI computed itself: `evaluateThesis(rule, fv)` for that trade's rule,
   *  resolved the same way §5.8a resolves a planId — `research-rules.json` for a rule-origin
   *  trade, `data/ai-rules/<planId>.json` for an AI-origin one, the decision file's `personaRule`
   *  for a persona-origin one. `not_evaluable` when the rule or a feature cannot be loaded (never
   *  a guess). */
  computedThesis: ThesisState;
  personaCfg: PersonaConfig;
  skillHash: string;
  now: number;
}

export interface ReviewContext {
  dateUtc: string;
  tradeArg: string;
  trade: ManualTrade | null;
  computed: ClosedTradeReview | null; // reviewClosedTrade(trade, klines1h); null iff trade is null or open
  personaCfg: PersonaConfig;
  skillHash: string;
  now: number;
}

// ── CLI args/deps (§5.15) ────────────────────────────────────────────────────────────────────

export interface DecideArgs {
  date: string;
  mode: "plan" | "manage" | "review";
  revise: boolean;
  trade: string | null; // --trade <journal trade id>; REQUIRED for mode "manage" and "review", rejected for "plan"
  input: string | null; // path; null = read stdin
  configPath: string; // default "./config.json"
  decisionsRoot: string; // default personaCfg.decisionsRoot
  reportsRoot: string; // default "reports"
  journalPath: string; // default "./manual-journal.json"
  rulesPath: string; // default "./research-rules.json"
  aiRulesRoot: string; // default "data/ai-rules"
  skillRoot: string; // default personaCfg.skillRoot
  syncStatusPath: string; // default "<journalPath minus .json>.sync.json", i.e. "./manual-journal.sync.json"
  // Not in §5.15's literal CLI flag list — like research-daily.ts's --snapshot-root etc., these
  // exist so tests never touch this repo's real data/snapshots, .claude/skills/ or prompts/.
  promptPath: string; // default "prompts/ai-analyst.md"
  repoRoot: string; // default process.cwd() — skillHash's relative-path root
  snapshotRoot: string; // default "data/snapshots" — to rebuild that date's FeatureVectors
}

/** Injected so every test runs offline and deterministically (same shape as research:daily's
 *  deps). */
export interface DecideDeps {
  now(): number;
  readStdin(): Promise<string>;
  fetchKlines?: typeof fetchKlines; // --mode review only, for reviewClosedTrade's 1h bars (§5.14)
}
