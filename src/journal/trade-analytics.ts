// Trade analytics — specs/daily-catalyst-manual-trading.md §5.9, formulas normative in §5.8a.
//
// Pure throughout: no I/O, no clock reads (now/lastSyncAt/staleAfterMs are inputs). `liveView`
// renders one open trade against the freshest known position/thesis; `reviewClosedTrade` scores
// one closed trade against its plan (or `null` fields when unplanned); `aggregate` rolls a set of
// reviews up per venue — venues are never blended (AC-34), by construction of the caller always
// passing single-venue reviews plus the `venue` tag carried through unchanged.

import type { ThesisState } from "../research/rules.ts";
import type { AiStance } from "../research/ai/types.ts";
import type { PlanOrigin } from "../research/planner.ts";
import type { Kline } from "../research/types.ts";
import type { ExitKind, Fill, ManualTrade, ManualTradeVenue } from "./types.ts";
import type { SyncResult } from "./exchange-sync.ts";

// ── Shared fill/PnL helpers (also used by src/journal/breaker.ts) ─────────────────────────────

function weightedAvgPrice(fills: readonly Fill[]): number | null {
  const qty = fills.reduce((sum, f) => sum + f.qty, 0);
  if (qty === 0) return null;
  return fills.reduce((sum, f) => sum + f.qty * f.price, 0) / qty;
}

function sumQty(fills: readonly Fill[]): number {
  return fills.reduce((sum, f) => sum + f.qty, 0);
}

function sumFees(t: ManualTrade): number {
  return [...t.entryFills, ...t.exitFills].reduce((sum, f) => sum + f.feeUsd, 0);
}

/** Earliest entry fill time, or 0 if somehow unset (should never happen for a real trade). */
export function firstEntryTime(t: ManualTrade): number {
  return t.entryFills.reduce((min, f) => Math.min(min, f.time), Number.POSITIVE_INFINITY) === Number.POSITIVE_INFINITY
    ? 0
    : t.entryFills.reduce((min, f) => Math.min(min, f.time), Number.POSITIVE_INFINITY);
}

/** Latest exit fill time, or 0 if the trade has no exits (still open). */
export function lastExitTime(t: ManualTrade): number {
  return t.exitFills.reduce((max, f) => Math.max(max, f.time), 0);
}

/** Gross PnL, §5.8a: long `Σexit(q·p) − Σentry(q·p)`, short negated. */
function grossPnlUsd(t: ManualTrade): number {
  const entryValue = t.entryFills.reduce((sum, f) => sum + f.qty * f.price, 0);
  const exitValue = t.exitFills.reduce((sum, f) => sum + f.qty * f.price, 0);
  const gross = exitValue - entryValue;
  return t.side === "long" ? gross : -gross;
}

/** `netPnlUsd = grossPnl − fees + fundingUsd` (§5.8a). Exported for src/journal/breaker.ts's
 *  circuit-breaker replay, which needs the same per-trade net result. */
export function netPnlUsdOf(t: ManualTrade): number {
  return grossPnlUsd(t) - sumFees(t) + t.fundingUsd;
}

// ── Live view (§5.9) ────────────────────────────────────────────────────────────────────────────

export interface LiveTradeView {
  tradeId: string;
  markPrice: number | null;
  unrealisedPnlUsd: number | null;
  distanceToStopPct: number | null;
  distanceToLiqPct: number | null;
  liqBeyondStop: boolean | null;
  fundingUsd: number;
  heldHours: number;
  hoursToExpiry: number | null;
  thesis: ThesisState;
  stale: boolean;
  staleSinceMs: number | null;
  alerts: ("stop_beyond_liquidation" | "size_deviates_from_plan" | "leverage_exceeds_plan" | "thesis_invalidated" | "expired" | "unplanned" | "data_stale")[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function liveView(
  t: ManualTrade,
  pos: SyncResult["positions"][number] | null,
  thesis: ThesisState,
  now: number,
  lastSyncAt: number,
  staleAfterMs: number,
): LiveTradeView {
  const stale = now - lastSyncAt > staleAfterMs;
  const mark = stale ? null : pos?.markPrice ?? null;
  const plan = t.plannedSnapshot;

  const liq = stale ? null : (t.exchangeLiqPrice ?? pos?.liqPrice ?? null);
  let distanceToStopPct: number | null = null;
  let distanceToLiqPct: number | null = null;
  let liqBeyondStop: boolean | null = null;
  if (mark !== null && plan !== null) {
    distanceToStopPct = t.side === "long"
      ? ((mark - plan.stopPrice) / mark) * 100
      : ((plan.stopPrice - mark) / mark) * 100;
    if (liq !== null) {
      distanceToLiqPct = t.side === "long" ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
      liqBeyondStop = t.side === "long" ? liq < plan.stopPrice : liq > plan.stopPrice;
    }
  }

  const entered = firstEntryTime(t);
  const heldHours = (now - entered) / HOUR_MS;
  // Time-to-forced-exit, not the plan's entry window (`expiresAt`, which stops mattering once
  // the trade is filled): hours remaining before `maxHoldDays` forces a "time" exit (§5.8a).
  const hoursToExpiry = plan !== null ? (entered + plan.maxHoldDays * DAY_MS - now) / HOUR_MS : null;

  const entryQty = sumQty(t.entryFills);
  const sizeDeviationPct = plan !== null && plan.quantity !== 0 ? Math.abs(entryQty / plan.quantity - 1) * 100 : null;

  // `liqBeyondStop` (per §5.9's literal formula) is true in the SAFE ordering — liquidation sits
  // further out than the stop, so the stop triggers first. The "stop_beyond_liquidation" alert
  // is the danger case: it fires when that is NOT true (liq sits between entry and stop, so
  // liquidation would trigger before the stop ever could).
  const alerts: LiveTradeView["alerts"] = [];
  if (liqBeyondStop === false) alerts.push("stop_beyond_liquidation");
  if (sizeDeviationPct !== null && sizeDeviationPct > 10) alerts.push("size_deviates_from_plan");
  if (plan !== null && t.actualLeverage !== null && t.actualLeverage > plan.leverage) alerts.push("leverage_exceeds_plan");
  if (thesis === "invalidated") alerts.push("thesis_invalidated");
  if (hoursToExpiry !== null && hoursToExpiry <= 0) alerts.push("expired");
  if (t.planId === null) alerts.push("unplanned");
  if (stale) alerts.push("data_stale");

  return {
    tradeId: t.id,
    markPrice: mark,
    unrealisedPnlUsd: stale ? null : pos?.unrealisedPnl ?? null,
    distanceToStopPct,
    distanceToLiqPct,
    liqBeyondStop,
    fundingUsd: t.fundingUsd,
    heldHours,
    hoursToExpiry,
    thesis,
    stale,
    staleSinceMs: stale ? lastSyncAt : null,
    alerts,
  };
}

// ── Closed-trade review (§5.9) ──────────────────────────────────────────────────────────────────

export interface ClosedTradeReview {
  tradeId: string;
  ruleId: string | null;
  ruleHash: string | null;
  origin: PlanOrigin | null;
  aiStanceAtPlan: AiStance | null;
  /** Revision 3: `plannedSnapshot.basedOnRuleKey`, null unless origin "persona" on a chosen
   *  report plan (§5.9). */
  basedOnRuleKey: string | null;
  plannedRiskUsd: number | null;
  netPnlUsd: number;
  feesUsd: number;
  fundingUsd: number;
  rMultiple: number | null;
  entrySlippagePct: number | null;
  sizeDeviationPct: number | null;
  maePct: number;
  mfePct: number;
  exitKind: ExitKind;
  followedPlan: boolean;
}

const FOLLOWED_EXIT_KINDS: readonly ExitKind[] = ["stop", "target", "time", "thesis_invalidated"];

/** Worst/best excursion of 1h kline lows/highs overlapping `[firstEntry, lastExit]`, relative to
 *  `avgEntry`, in the trade's direction (MAE ≤ 0 ≤ MFE). Klines outside the window don't count;
 *  a trade with no overlapping kline yields 0/0 (no excursion data, not "missing" — callers that
 *  need to know data was unavailable should check kline coverage themselves; §5.9 doesn't define
 *  a not-evaluable state for this pair). */
function maeMfePct(side: "long" | "short", avgEntry: number, from: number, to: number, klines1h: readonly Kline[]): { maePct: number; mfePct: number } {
  let worst = 0;
  let best = 0;
  for (const k of klines1h) {
    const barEnd = k.t + HOUR_MS;
    if (barEnd <= from || k.t > to) continue;
    const upPct = ((k.h - avgEntry) / avgEntry) * 100;
    const downPct = ((k.l - avgEntry) / avgEntry) * 100;
    const favorable = side === "long" ? upPct : -downPct;
    const adverse = side === "long" ? downPct : -upPct;
    if (favorable > best) best = favorable;
    if (adverse < worst) worst = adverse;
  }
  return { maePct: worst, mfePct: best };
}

export function reviewClosedTrade(t: ManualTrade, klines1h: readonly Kline[]): ClosedTradeReview {
  const plan = t.plannedSnapshot;
  const netPnlUsd = netPnlUsdOf(t);
  const feesUsd = sumFees(t);
  const plannedRiskUsd = plan?.riskUsd ?? null;
  const rMultiple = plannedRiskUsd !== null && plannedRiskUsd !== 0 ? netPnlUsd / plannedRiskUsd : null;

  const avgEntry = weightedAvgPrice(t.entryFills);
  const entrySlippagePct = plan !== null && avgEntry !== null
    ? (t.side === "long" ? (avgEntry / plan.referencePrice - 1) * 100 : (1 - avgEntry / plan.referencePrice) * 100)
    : null;

  const entryQty = sumQty(t.entryFills);
  const sizeDeviationPct = plan !== null && plan.quantity !== 0 ? Math.abs(entryQty / plan.quantity - 1) * 100 : null;

  const exitKind = t.exitKind ?? "unknown";
  const followedPlan = plan !== null
    && FOLLOWED_EXIT_KINDS.includes(exitKind)
    && (sizeDeviationPct === null || sizeDeviationPct <= 10)
    && (t.venue === "paper" || t.actualLeverage === null || t.actualLeverage <= plan.leverage);

  const { maePct, mfePct } = avgEntry !== null
    ? maeMfePct(t.side, avgEntry, firstEntryTime(t), lastExitTime(t), klines1h)
    : { maePct: 0, mfePct: 0 };

  return {
    tradeId: t.id,
    ruleId: t.ruleId,
    ruleHash: t.ruleHash,
    origin: plan?.origin ?? null,
    aiStanceAtPlan: t.aiStanceAtPlan,
    basedOnRuleKey: plan?.basedOnRuleKey ?? null,
    plannedRiskUsd,
    netPnlUsd,
    feesUsd,
    fundingUsd: t.fundingUsd,
    rMultiple,
    entrySlippagePct,
    sizeDeviationPct,
    maePct,
    mfePct,
    exitKind,
    followedPlan,
  };
}

// ── Aggregate (§5.9) ─────────────────────────────────────────────────────────────────────────────

export interface AggregateStats {
  venue: ManualTradeVenue;
  closedTrades: number;
  winRate: number | null;
  expectancyR: number | null;
  totalNetPnlUsd: number;
  maxDrawdownR: number | null;
  adherenceRate: number | null;
  /** key "<ruleId>@<first 8 chars of ruleHash>" so rule versions never blend (§5.9). */
  byRule: Record<string, { closed: number; expectancyR: number | null; netPnlUsd: number }>;
  byOrigin: Record<PlanOrigin, { closed: number; expectancyR: number | null; netPnlUsd: number }>;
  byAiStance: Record<AiStance | "none", { closed: number; expectancyR: number | null; winRate: number | null }>;
  /** Revision 3. Closed persona-origin trades whose decision picked another channel's plan,
   *  grouped by that plan's rule: key = `basedOnRuleKey` ("<ruleId>@<first 8 chars of ruleHash>",
   *  same format as `byRule`). Answers "which rules does the persona actually pick, and how do
   *  those picks do?" Persona ideas of the persona's own (no `basedOnPlanId`) are not counted
   *  here — they appear only in `byOrigin.persona`. It counts *closed trades*, not decisions. */
  chosenByPersona: Record<string, { closed: number; expectancyR: number | null; netPnlUsd: number }>;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function bucket(): { closed: number; expectancyR: number | null; netPnlUsd: number; rs: number[] } {
  return { closed: 0, expectancyR: null, netPnlUsd: 0, rs: [] };
}

export function aggregate(reviews: readonly ClosedTradeReview[], venue: ManualTradeVenue): AggregateStats {
  const closedTrades = reviews.length;
  const winRate = closedTrades === 0 ? null : reviews.filter((r) => r.netPnlUsd > 0).length / closedTrades;
  const rValues = reviews.map((r) => r.rMultiple).filter((r): r is number => r !== null);
  const expectancyR = mean(rValues);
  const totalNetPnlUsd = reviews.reduce((sum, r) => sum + r.netPnlUsd, 0);

  // Largest peak-to-trough of cumulative R, in exit order (caller passes reviews already
  // ordered by exit time — reviewClosedTrade carries no timestamp of its own to re-sort by).
  let maxDrawdownR: number | null = null;
  if (rValues.length > 0) {
    let cumulative = 0;
    let peak = 0;
    let worstDrawdown = 0;
    for (const r of rValues) {
      cumulative += r;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > worstDrawdown) worstDrawdown = drawdown;
    }
    maxDrawdownR = worstDrawdown;
  }

  const plannedFollowed = reviews.filter((r) => r.plannedRiskUsd !== null && r.followedPlan).length;
  const adherenceRate = closedTrades === 0 ? null : plannedFollowed / closedTrades;

  const byRule: AggregateStats["byRule"] = {};
  const byOrigin: AggregateStats["byOrigin"] = {
    "rules-file": { closed: 0, expectancyR: null, netPnlUsd: 0 },
    "ai-analyst": { closed: 0, expectancyR: null, netPnlUsd: 0 },
    "persona": { closed: 0, expectancyR: null, netPnlUsd: 0 },
  };
  const byAiStance: AggregateStats["byAiStance"] = {
    support: { closed: 0, expectancyR: null, winRate: null },
    caution: { closed: 0, expectancyR: null, winRate: null },
    oppose: { closed: 0, expectancyR: null, winRate: null },
    none: { closed: 0, expectancyR: null, winRate: null },
  };
  const chosenByPersona: AggregateStats["chosenByPersona"] = {};

  const ruleBuckets = new Map<string, ReturnType<typeof bucket>>();
  const originBuckets: Record<PlanOrigin, ReturnType<typeof bucket>> = {
    "rules-file": bucket(), "ai-analyst": bucket(), "persona": bucket(),
  };
  const stanceBuckets: Record<AiStance | "none", { rs: number[]; wins: number; closed: number }> = {
    support: { rs: [], wins: 0, closed: 0 }, caution: { rs: [], wins: 0, closed: 0 },
    oppose: { rs: [], wins: 0, closed: 0 }, none: { rs: [], wins: 0, closed: 0 },
  };
  const chosenBuckets = new Map<string, ReturnType<typeof bucket>>();

  for (const r of reviews) {
    // Unplanned trades (no ruleId) are skipped, as before; a ruleId without a hash (should not
    // happen for a linked trade) is skipped too since the key requires both (§5.9).
    if (r.ruleId !== null && r.ruleHash !== null) {
      const key = `${r.ruleId}@${r.ruleHash.slice(0, 8)}`;
      const b = ruleBuckets.get(key) ?? bucket();
      b.closed += 1;
      b.netPnlUsd += r.netPnlUsd;
      if (r.rMultiple !== null) b.rs.push(r.rMultiple);
      ruleBuckets.set(key, b);
    }
    if (r.origin !== null) {
      const b = originBuckets[r.origin];
      b.closed += 1;
      b.netPnlUsd += r.netPnlUsd;
      if (r.rMultiple !== null) b.rs.push(r.rMultiple);
    }
    // byAiStance: rule-origin trades only (§5.9) — AI-origin trades never appear here.
    if (r.origin === "rules-file") {
      const stance = r.aiStanceAtPlan ?? "none";
      const s = stanceBuckets[stance];
      s.closed += 1;
      if (r.rMultiple !== null) s.rs.push(r.rMultiple);
      if (r.netPnlUsd > 0) s.wins += 1;
    }
    // chosenByPersona (revision 3): closed persona-origin trades whose decision picked another
    // channel's plan (basedOnRuleKey non-null); a persona idea of its own is not counted here.
    if (r.origin === "persona" && r.basedOnRuleKey !== null) {
      const b = chosenBuckets.get(r.basedOnRuleKey) ?? bucket();
      b.closed += 1;
      b.netPnlUsd += r.netPnlUsd;
      if (r.rMultiple !== null) b.rs.push(r.rMultiple);
      chosenBuckets.set(r.basedOnRuleKey, b);
    }
  }

  for (const [key, b] of ruleBuckets) {
    byRule[key] = { closed: b.closed, expectancyR: mean(b.rs), netPnlUsd: b.netPnlUsd };
  }
  for (const origin of ["rules-file", "ai-analyst", "persona"] as const) {
    const b = originBuckets[origin];
    byOrigin[origin] = { closed: b.closed, expectancyR: mean(b.rs), netPnlUsd: b.netPnlUsd };
  }
  for (const stance of ["support", "caution", "oppose", "none"] as const) {
    const s = stanceBuckets[stance];
    byAiStance[stance] = { closed: s.closed, expectancyR: mean(s.rs), winRate: s.closed === 0 ? null : s.wins / s.closed };
  }
  for (const [key, b] of chosenBuckets) {
    chosenByPersona[key] = { closed: b.closed, expectancyR: mean(b.rs), netPnlUsd: b.netPnlUsd };
  }

  return {
    venue, closedTrades, winRate, expectancyR, totalNetPnlUsd, maxDrawdownR, adherenceRate,
    byRule, byOrigin, byAiStance, chosenByPersona,
  };
}
