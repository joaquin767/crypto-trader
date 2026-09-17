// AI output verification — specs/daily-catalyst-manual-trading.md §5.13, §4.16, §6.8 AC-42..45.
//
// Pure. This is the AI channel's only defense against a hallucinated or manipulated feature
// value, a URL the model never actually retrieved, a reference to a plan/trade that doesn't
// exist, or simply too many ideas — every item that fails a check is dropped and recorded in
// `rejected`, never silently kept or "corrected" (P1, fail closed; §7 "AI: cites a feature value
// that differs from the snapshot... -> Item dropped and listed in rejected; never shown as fact").
//
// Order of operations per item type, all normative from §5.13's doc comment:
//  - planAssessments: unknown planId drops the whole assessment; otherwise each reason is kept
//    only if every one of its refs verifies (a reason with a failing ref is dropped); an
//    assessment left with zero reasons is dropped (its per-reason rejections already explain why,
//    so no separate "assessment-level" rejected item is added).
//  - openTradeNotes: unknown tradeId, or any failing ref, drops the whole note.
//  - ideas: symbol not in configSymbols, zero refs, an out-of-range numeric field, or any failing
//    ref drops the idea; ideas beyond `maxIdeas` (in output order, after dropping) are dropped as
//    "over_limit".
//
// `maxHoldDays` is additionally required to be an integer here even though §5.13's prose only
// states the 1..10 range: `aiIdeaToRule` copies it straight into `RuleDefinition.maxHoldDays`,
// which `src/research/rules.ts`'s own validation (and every other producer of a RuleDefinition)
// treats as an integer — the same "stay conservative even where the spec's prose under-specifies"
// choice src/research/rules.ts's file header documents for evaluateThesis.

import type { FeatureName, FeatureVector } from "../types.ts";
import type { TradePlan } from "../planner.ts";
import type { AiAnalystInput, AiAnalystOutput, AiEvidenceRef, AiIdea, AiPlanAssessment, AiRejectedItem } from "./types.ts";

const FEATURE_TOLERANCE_ABS = 1e-9;

function findFeatureValue(features: readonly FeatureVector[], symbol: string, feature: FeatureName): number | null {
  const fv = features.find((f) => f.symbol === symbol);
  if (!fv) return null;
  const val = fv.features[feature];
  return val && val.kind === "value" ? val.value : null;
}

/** A single ref's verification outcome, or null when it verifies. */
function refFailure(
  ref: AiEvidenceRef,
  features: readonly FeatureVector[],
  webResultUrls: ReadonlySet<string>,
): AiRejectedItem["reason"] | null {
  if (ref.kind === "feature") {
    const actual = findFeatureValue(features, ref.symbol, ref.feature);
    if (actual === null) return "unverifiable_feature";
    const tolerance = FEATURE_TOLERANCE_ABS * Math.max(1, Math.abs(actual));
    return Math.abs(actual - ref.value) <= tolerance ? null : "unverifiable_feature";
  }
  return webResultUrls.has(ref.url) ? null : "unverifiable_web";
}

/** First failing ref's reason, or null if every ref verifies (including the empty-refs case). */
function firstFailingRef(
  refs: readonly AiEvidenceRef[],
  features: readonly FeatureVector[],
  webResultUrls: ReadonlySet<string>,
): AiRejectedItem["reason"] | null {
  for (const ref of refs) {
    const failure = refFailure(ref, features, webResultUrls);
    if (failure !== null) return failure;
  }
  return null;
}

function isInRange(v: number, lo: number, hi: number, loInclusive: boolean): boolean {
  return Number.isFinite(v) && (loInclusive ? v >= lo : v > lo) && v <= hi;
}

/** `aiIdeaToRule` copies `invalidateWhenAny` straight into a RuleDefinition without going through
 *  src/research/rules.ts's parser, so its `between` rule (a `[lo, hi]` pair with lo <= hi; a
 *  scalar for every other comparator) is enforced here — a malformed condition drops the idea. */
function conditionMalformed(cond: AiIdea["invalidateWhenAny"][number]): boolean {
  if (cond.op === "between") {
    return !Array.isArray(cond.value) || cond.value.length !== 2 ||
      !Number.isFinite(cond.value[0]) || !Number.isFinite(cond.value[1]) || cond.value[0] > cond.value[1];
  }
  return typeof cond.value !== "number" || !Number.isFinite(cond.value);
}

function ideaOutOfRange(idea: AiIdea): boolean {
  return (
    !isInRange(idea.confidence, 0, 1, true) ||
    !isInRange(idea.stopAtrMultiple, 0, 10, false) ||
    !isInRange(idea.targetRMultiple, 0, 20, false) ||
    !Number.isInteger(idea.maxHoldDays) || idea.maxHoldDays < 1 || idea.maxHoldDays > 10 ||
    idea.invalidateWhenAny.some(conditionMalformed)
  );
}

/** Pure. See file header for the exact per-item-type rules. */
export function verifyAiOutput(
  out: AiAnalystOutput,
  input: AiAnalystInput,
  webResults: readonly { url: string }[],
  maxIdeas: number,
): { output: AiAnalystOutput; rejected: AiRejectedItem[] } {
  const rejected: AiRejectedItem[] = [];
  const webResultUrls = new Set(webResults.map((w) => w.url));
  const validPlanIds = new Set(
    input.rulePlans.filter((p): p is Extract<TradePlan, { kind: "plan" }> => p.kind === "plan").map((p) => p.planId),
  );
  const knownTradeIds = new Set(input.openTrades.map((t) => t.tradeId));

  // ── planAssessments ──────────────────────────────────────────────────────────────────────
  const planAssessments: AiPlanAssessment[] = [];
  out.planAssessments.forEach((assessment, i) => {
    if (!validPlanIds.has(assessment.planId)) {
      rejected.push({ path: `planAssessments[${i}]`, reason: "unknown_plan" });
      return;
    }
    const keptReasons = assessment.reasons.filter((reason, j) => {
      const failure = firstFailingRef(reason.refs, input.features, webResultUrls);
      if (failure !== null) {
        rejected.push({ path: `planAssessments[${i}].reasons[${j}]`, reason: failure });
        return false;
      }
      return true;
    });
    if (keptReasons.length > 0) planAssessments.push({ ...assessment, reasons: keptReasons });
  });

  // ── openTradeNotes ───────────────────────────────────────────────────────────────────────
  const openTradeNotes: AiAnalystOutput["openTradeNotes"] = [];
  out.openTradeNotes.forEach((note, i) => {
    if (!knownTradeIds.has(note.tradeId)) {
      rejected.push({ path: `openTradeNotes[${i}]`, reason: "unknown_trade" });
      return;
    }
    const failure = firstFailingRef(note.refs, input.features, webResultUrls);
    if (failure !== null) {
      rejected.push({ path: `openTradeNotes[${i}]`, reason: failure });
      return;
    }
    openTradeNotes.push(note);
  });

  // ── ideas ────────────────────────────────────────────────────────────────────────────────
  const survivingIdeas: { idea: AiIdea; originalIndex: number }[] = [];
  out.ideas.forEach((idea, i) => {
    if (idea.refs.length === 0) {
      rejected.push({ path: `ideas[${i}]`, reason: "no_evidence" });
      return;
    }
    if (!input.configSymbols.includes(idea.symbol)) {
      rejected.push({ path: `ideas[${i}]`, reason: "symbol_not_configured" });
      return;
    }
    if (ideaOutOfRange(idea)) {
      rejected.push({ path: `ideas[${i}]`, reason: "out_of_range" });
      return;
    }
    const failure = firstFailingRef(idea.refs, input.features, webResultUrls);
    if (failure !== null) {
      rejected.push({ path: `ideas[${i}]`, reason: failure });
      return;
    }
    survivingIdeas.push({ idea, originalIndex: i });
  });

  const ideas: AiIdea[] = [];
  survivingIdeas.forEach(({ idea, originalIndex }, order) => {
    if (order < maxIdeas) {
      ideas.push(idea);
    } else {
      rejected.push({ path: `ideas[${originalIndex}]`, reason: "over_limit" });
    }
  });

  return {
    output: { ...out, planAssessments, ideas, openTradeNotes },
    rejected,
  };
}
