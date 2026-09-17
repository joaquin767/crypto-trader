// Gate D1 — specs/daily-catalyst-manual-trading.md §5.10 (canonical declarations) / §5.10a
// "d1-check" (normative behavior), §8.2.
//
// `runGateD1` is pure given its inputs. The pure helpers below (selection, artifact choice,
// unexplainedIncompleteDays) are also pure — the CLI (scripts/backtest-daily.ts) does the actual
// file-system work (loading manual-journal.json, listing gate-d0 artifacts, listing/reading
// reports/, reading docs/validation/d1-<ruleId>.md) and passes already-loaded data in.
//
// Spec gap resolved here (flagged in the phase report): §5.9's `ClosedTradeReview` (the type
// §5.10's canonical `runGateD1(reviews: readonly ClosedTradeReview[], ...)` names) carries no
// `venue` field, yet §5.10a requires "Reviews must all be venue 'paper' ... (throws Error
// otherwise)". Rather than adding a field to the Phase 3 `ClosedTradeReview` type (which would
// ripple into every existing caller/test of src/journal/trade-analytics.ts for a Phase 4b-only
// need), `runGateD1` here accepts `ClosedTradeReview & { venue: ManualTradeVenue }` — a strict
// superset the CLI builds by pairing each `reviewClosedTrade` result with its source
// `ManualTrade.venue`, which it already has on hand.

import type { ClosedTradeReview } from "../journal/trade-analytics.ts";
import type { ManualTrade, ManualTradeVenue } from "../journal/types.ts";
import type { Condition, RuleDefinition } from "../research/rules.ts";
import type { FeatureName, SourceId } from "../research/types.ts";
import { FEATURE_SOURCE_ID } from "../research/features.ts";
import { d0Block30P10 } from "./stats.ts";
import type { GateD0Report } from "./gate-d0.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GateD1Report {
  schemaVersion: 1;
  generatedAt: number;
  command: string;
  ruleId: string;
  ruleHash: string;
  forwardOnly: boolean;
  closedPaperTrades: number;
  calendarDays: number;
  expectancyR: number | null;
  adherenceRate: number | null;
  d0Block30P10: number | null; // null iff forwardOnly
  unexplainedIncompleteDays: number;
  verdict: "paper_passed" | "not_yet" | "failed";
  verdictReason: string;
}

/** See file header: the review shape `runGateD1` actually needs, a strict superset of
 *  ClosedTradeReview. */
export type D1Review = ClosedTradeReview & { venue: ManualTradeVenue };

// ── Selection helpers (pure) ─────────────────────────────────────────────────────────────────

/** Closed paper trades matching both `ruleId` AND `ruleHash` (§5.10a "Reviews": "so trades from
 *  a previous rule version don't count", AC-88). */
/** `hashMatch: "prefix"` is only for `ai-analyst-<hash8>` ids, whose id carries the first 8 chars of the
 *  full promptVersionHash stored on each trade; rules-file rules always match the full hash exactly. */
export function selectPaperTradesForRule(trades: readonly ManualTrade[], ruleId: string, ruleHash: string,
  hashMatch: "exact" | "prefix" = "exact"): ManualTrade[] {
  const hashOk = (h: string | null): boolean =>
    h !== null && (hashMatch === "exact" ? h === ruleHash : ruleHash.length >= 8 && h.startsWith(ruleHash));
  return trades.filter((t) => t.status === "closed" && t.venue === "paper" && t.ruleId === ruleId && hashOk(t.ruleHash));
}

/** The newest `edge_confirmed` gate-d0 artifact whose `ruleHash` matches the current rule; null
 *  if none (§5.10a "d0Holdout", AC-88). */
export function selectD0HoldoutArtifact(artifacts: readonly GateD0Report[], ruleHash: string): GateD0Report | null {
  const candidates = artifacts.filter((a) => a.verdict === "edge_confirmed" && a.ruleHash === ruleHash);
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, a) => (a.generatedAt > newest.generatedAt ? a : newest));
}

/** Every SourceId feeding a feature the rule references, from entryWhenAll + invalidateWhenAny
 *  (§5.10a "unexplainedIncompleteDays": "only sources feeding the rule's referenced features
 *  count"). */
export function ruleFeatureSourceIds(rule: Pick<RuleDefinition, "entryWhenAll" | "invalidateWhenAny">): Set<SourceId> {
  const features = new Set<FeatureName>();
  for (const c of [...rule.entryWhenAll, ...rule.invalidateWhenAny] as Condition[]) features.add(c.feature);
  return new Set([...features].map((f) => FEATURE_SOURCE_ID[f]));
}

const EXPLAINED_LINE_RE = /^-\s*(\d{4}-\d{2}-\d{2})\s*:/;

/** Parses `docs/validation/d1-<ruleId>.md` lines of the form `- YYYY-MM-DD: <reason>` into the
 *  set of explained dates (§5.10a). Unrelated lines (headings, prose) are ignored. */
export function parseExplainedDates(docContent: string): Set<string> {
  const dates = new Set<string>();
  for (const rawLine of docContent.split("\n")) {
    const m = EXPLAINED_LINE_RE.exec(rawLine.trim());
    if (m) dates.add(m[1]!);
  }
  return dates;
}

export interface DayReportSummary {
  date: string;
  /** false when no reports/<date>(.rN).json exists at all — "a missing report counts as
   *  incomplete" (§5.10a). */
  found: boolean;
  /** SourceIds with a non-"ok" status in that day's report; empty (and irrelevant) when !found. */
  nonOkSources: readonly SourceId[];
}

/** UTC days from the first paper entry to now whose report has any non-ok source feeding a
 *  feature the rule references, minus the dates listed in docs/validation/d1-<ruleId>.md
 *  (§5.10a). */
export function unexplainedIncompleteDays(
  days: readonly DayReportSummary[],
  relevantSources: ReadonlySet<SourceId>,
  explainedDates: ReadonlySet<string>,
): number {
  let count = 0;
  for (const d of days) {
    const incomplete = !d.found || d.nonOkSources.some((s) => relevantSources.has(s));
    if (incomplete && !explainedDates.has(d.date)) count++;
  }
  return count;
}

// ── Pure verdict ─────────────────────────────────────────────────────────────────────────────

export interface RunGateD1Options {
  ruleId: string;
  ruleHash: string;
  forwardOnly: boolean;
  firstPaperEntryTime: number;
  now: number;
  /** holdoutTradeR + holdoutTradeDays from the rule's passing gate-d0 artifact; null iff
   *  forwardOnly (or no passing artifact exists). */
  d0Holdout: { r: readonly number[]; days: readonly string[] } | null;
  unexplainedIncompleteDays: number;
  seed: number;
  resamples: number;
  command: string;
}

/**
 * Pure. Reviews must all be venue "paper" and ruleId-matching (throws Error otherwise). Verdict
 * order (first match decides, §5.10a "d1-check"):
 * 1. !forwardOnly && (d0Holdout is null or has no trades) -> failed
 * 2. closedPaperTrades < minTrades (30, 60 if forwardOnly) or calendarDays < 45 -> not_yet
 * 3. expectancyR <= 0 -> failed
 * 4. !forwardOnly && expectancyR < d0Block30P10 -> failed
 * 5. adherenceRate < 0.90 -> failed
 * 6. unexplainedIncompleteDays > 0 -> not_yet
 * 7. else paper_passed
 */
export function runGateD1(reviews: readonly D1Review[], opts: RunGateD1Options): GateD1Report {
  for (const r of reviews) {
    if (r.venue !== "paper" || r.ruleId !== opts.ruleId) {
      throw new Error(
        `runGateD1: review "${r.tradeId}" has venue="${r.venue}" ruleId="${r.ruleId}", expected venue="paper" ruleId="${opts.ruleId}"`,
      );
    }
  }

  const closedPaperTrades = reviews.length;
  const calendarDays = Math.floor((opts.now - opts.firstPaperEntryTime) / DAY_MS);
  const rValues = reviews.map((r) => r.rMultiple).filter((r): r is number => r !== null);
  const expectancyR = rValues.length > 0 ? rValues.reduce((a, b) => a + b, 0) / rValues.length : null;
  const followed = reviews.filter((r) => r.followedPlan).length;
  const adherenceRate = closedPaperTrades > 0 ? followed / closedPaperTrades : null;

  const minTrades = opts.forwardOnly ? 60 : 30;
  const hasD0Holdout = opts.d0Holdout !== null && opts.d0Holdout.r.length > 0;
  const block30P10 = !opts.forwardOnly && hasD0Holdout ? d0Block30P10(opts.d0Holdout!, opts.resamples, opts.seed) : null;

  let verdict: GateD1Report["verdict"];
  let verdictReason: string;

  if (!opts.forwardOnly && !hasD0Holdout) {
    verdict = "failed";
    verdictReason = "step 1: no passing Gate D0 artifact to compare against";
  } else if (closedPaperTrades < minTrades || calendarDays < 45) {
    verdict = "not_yet";
    verdictReason = `step 2: closedPaperTrades=${closedPaperTrades} (need >=${minTrades}) or calendarDays=${calendarDays} (need >=45)`;
  } else if (expectancyR === null || expectancyR <= 0) {
    verdict = "failed";
    verdictReason = `step 3: expectancyR=${expectancyR} <= 0`;
  } else if (!opts.forwardOnly && block30P10 !== null && expectancyR < block30P10) {
    verdict = "failed";
    verdictReason = `step 4: expectancyR=${expectancyR} < d0Block30P10=${block30P10}`;
  } else if (adherenceRate === null || adherenceRate < 0.9) {
    verdict = "failed";
    verdictReason = `step 5: adherenceRate=${adherenceRate} < 0.90`;
  } else if (opts.unexplainedIncompleteDays > 0) {
    verdict = "not_yet";
    verdictReason = `step 6: unexplainedIncompleteDays=${opts.unexplainedIncompleteDays} > 0`;
  } else {
    verdict = "paper_passed";
    verdictReason = "step 7: all checks passed";
  }

  return {
    schemaVersion: 1,
    generatedAt: opts.now,
    command: opts.command,
    ruleId: opts.ruleId,
    ruleHash: opts.ruleHash,
    forwardOnly: opts.forwardOnly,
    closedPaperTrades,
    calendarDays,
    expectancyR,
    adherenceRate,
    d0Block30P10: block30P10,
    unexplainedIncompleteDays: opts.unexplainedIncompleteDays,
    verdict,
    verdictReason,
  };
}
