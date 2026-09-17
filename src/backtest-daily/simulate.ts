// Trade simulation — specs/daily-catalyst-manual-trading.md §5.10 (canonical signature) /
// §5.10a "Simulation" (normative behavior).
//
// Pure: no I/O, no clock reads. `decisionTime` is not a parameter of the canonical signature —
// per §5.10a it is derived from the plan itself: `planId` is `${dateUtc}:${ruleId}:${symbol}`
// (src/research/planner.ts), so `decisionTime = Date.parse(\`${dateUtc}T00:15:00Z\`)`, matching
// the fixed decision time used everywhere else (§5.11 `decisionTimeUtc`, §5.10a's replay loop).

import type { SourceRow } from "../research/types.ts";
import type { Kline } from "../research/types.ts";
import type { TradePlan } from "../research/planner.ts";

export interface SimTrade {
  planId: string;
  ruleId: string;
  symbol: string;
  decisionDay: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  exitKind: "stop" | "target" | "time";
  netPnlUsd: number;
  riskUsd: number;
  rMultiple: number;
  fundingUsd: number;
  feesUsd: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TAKER_FEE_RATE = 0.00055; // 0.055%, §5.10a "Costs"

function adverseEntryFill(price: number, side: "long" | "short", slip: number): number {
  // Long pays more (buys higher), short "pays more" by selling lower — both worse than the raw price.
  return side === "long" ? price * (1 + slip) : price * (1 - slip);
}

function adverseExitFill(price: number, side: "long" | "short", slip: number): number {
  // Exiting a long sells (adverse = lower); exiting a short buys to cover (adverse = higher).
  return side === "long" ? price * (1 - slip) : price * (1 + slip);
}

/** close of the 1h bar containing `ts` (bar.t <= ts < bar.t + 1h), else the bar closing exactly at `ts`
 *  (a settlement on the exit boundary); null if neither is known. */
function markAt(bars: readonly Kline[], ts: number): number | null {
  for (const bar of bars) {
    if (bar.t <= ts && ts < bar.t + HOUR_MS) return bar.c;
  }
  for (const bar of bars) {
    if (bar.t + HOUR_MS === ts) return bar.c;
  }
  return null;
}

/** Longest Bybit funding interval (1, 2, 4 or 8 h). Wider spacing between consecutive settlements means
 *  history is missing rows, and a missing settlement would understate funding cost. */
const MAX_FUNDING_INTERVAL_MS = 8 * HOUR_MS + 60_000;

/**
 * Pure. See §5.10a "Simulation":
 * - Entry: open of the first 1h bar with t >= decisionTime, adjusted adversely by slippageBps.
 *   Quantity, stop and target come from the plan — levels are not re-anchored to the fill.
 * - Bars after entry (starting with the entry bar itself) are checked in order: a gap through a
 *   level at the open exits there (worse than the stop, no bonus past the target); otherwise an
 *   intrabar touch of both levels resolves to the stop (AC-20); a touch of only one resolves to
 *   that level.
 * - Time exit: at the close of the last bar with t + 1h <= entryBarTime + maxHoldDays*24h.
 * - Every exit price is adjusted adversely by slippageBps. Fees: taker 0.055% of notional/side.
 * - Funding: for each row with entryTime < ts <= exitTime, fundingUsd -= side*rate*qty*markAt(ts).
 * - Unfilled (never guessed): no bar at or after decision time, a missing bar before the exit
 *   (gap in the 1h series), or any needed bar beyond cutoffMs.
 */
export function simulatePlan(
  plan: Extract<TradePlan, { kind: "plan" }>,
  klines1h: readonly Kline[],
  funding: readonly SourceRow[],
  maxHoldDays: number,
  slippageBps: number,
  cutoffMs: number,
): SimTrade | { kind: "unfilled"; reason: string } {
  const decisionDay = plan.planId.split(":")[0]!;
  const decisionTime = Date.parse(`${decisionDay}T00:15:00Z`);

  const bars = [...klines1h].sort((a, b) => a.t - b.t);
  const entryIdx = bars.findIndex((b) => b.t >= decisionTime);
  if (entryIdx === -1) return { kind: "unfilled", reason: "no bar at or after decision time" };

  const entryBar = bars[entryIdx]!;
  if (entryBar.t + HOUR_MS > cutoffMs) {
    return { kind: "unfilled", reason: `entry bar at t=${entryBar.t} is beyond cutoffMs` };
  }

  const side = plan.side;
  const slip = slippageBps / 10_000;
  const entryPrice = adverseEntryFill(entryBar.o, side, slip);
  const { stopPrice, targetPrice } = plan;
  const boundary = entryBar.t + maxHoldDays * DAY_MS;

  let lastBar = entryBar;
  let rawExitPrice: number | null = null;
  let exitKind: "stop" | "target" | null = null;
  let exitTime = 0;
  let reachedBoundary = false;

  for (let i = entryIdx; i < bars.length; i++) {
    const bar = bars[i]!;
    if (bar.t + HOUR_MS > boundary) { reachedBoundary = true; break; } // not needed — time exit uses lastBar

    if (i > entryIdx && bar.t - lastBar.t !== HOUR_MS) {
      return { kind: "unfilled", reason: `gap in 1h bars between t=${lastBar.t} and t=${bar.t}` };
    }
    if (bar.t + HOUR_MS > cutoffMs) {
      return { kind: "unfilled", reason: `needed bar at t=${bar.t} is beyond cutoffMs` };
    }

    const gapStop = side === "long" ? bar.o <= stopPrice : bar.o >= stopPrice;
    const gapTarget = side === "long" ? bar.o >= targetPrice : bar.o <= targetPrice;
    if (gapStop) {
      rawExitPrice = bar.o; exitKind = "stop"; exitTime = bar.t;
    } else if (gapTarget) {
      rawExitPrice = targetPrice; exitKind = "target"; exitTime = bar.t;
    } else {
      const stopHit = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
      const targetHit = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
      // An intrabar touch happened somewhere inside the hour: exitTime is the bar's close so any funding
      // settlement in that hour is charged (conservative). A gap at the open above keeps the open time.
      if (stopHit) { rawExitPrice = stopPrice; exitKind = "stop"; exitTime = bar.t + HOUR_MS; } // AC-20: both hit -> stop wins
      else if (targetHit) { rawExitPrice = targetPrice; exitKind = "target"; exitTime = bar.t + HOUR_MS; }
    }
    if (exitKind !== null) break;
    lastBar = bar;
  }

  let finalExitKind: "stop" | "target" | "time";
  let finalRawExitPrice: number;
  if (exitKind !== null) {
    finalExitKind = exitKind;
    finalRawExitPrice = rawExitPrice!;
  } else if (reachedBoundary || lastBar.t + HOUR_MS >= boundary) {
    // Either a later bar confirmed we're past the hold window, or `lastBar` itself is exactly
    // the last bar the window needs (its close lands exactly on the boundary) — both are a
    // clean time exit, not missing data.
    finalExitKind = "time";
    finalRawExitPrice = lastBar.c;
    exitTime = lastBar.t + HOUR_MS; // "at the close of the last bar" (§5.10a)
  } else {
    return { kind: "unfilled", reason: "ran out of 1h bars before the max-hold time (gap)" };
  }

  const exitPrice = adverseExitFill(finalRawExitPrice, side, slip);
  const qty = plan.quantity;
  const grossPnl = side === "long" ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const feesUsd = qty * entryPrice * TAKER_FEE_RATE + qty * exitPrice * TAKER_FEE_RATE;

  // Funding history must cover the whole hold without holes: settlements from the last one at or before
  // entry through the first one at or after exit, each no more than MAX_FUNDING_INTERVAL_MS apart.
  const symbolFunding = funding
    .filter((row) => row.field === "fundingRate" && row.key === plan.symbol)
    .map((row) => row.observedFor)
    .sort((a, b) => a - b);
  const before = symbolFunding.filter((ts) => ts <= entryBar.t).at(-1);
  const after = symbolFunding.find((ts) => ts >= exitTime);
  if (before === undefined || after === undefined) {
    return { kind: "unfilled", reason: "gap in funding history: settlements do not cover the hold period" };
  }
  const covering = symbolFunding.filter((ts) => ts >= before && ts <= after);
  for (let i = 1; i < covering.length; i++) {
    if (covering[i]! - covering[i - 1]! > MAX_FUNDING_INTERVAL_MS) {
      return { kind: "unfilled", reason: `gap in funding history between t=${covering[i - 1]} and t=${covering[i]}` };
    }
  }

  const sideSign = side === "long" ? 1 : -1;
  let fundingUsd = 0;
  for (const row of funding) {
    if (row.field !== "fundingRate" || row.key !== plan.symbol) continue;
    const ts = row.observedFor;
    if (!(ts > entryBar.t && ts <= exitTime)) continue;
    const mark = markAt(bars, ts);
    // Never skip a settlement: an unpriceable one would understate cost (P1).
    if (mark === null) return { kind: "unfilled", reason: `gap: no 1h bar to price funding at t=${ts}` };
    fundingUsd -= sideSign * Number(row.value) * qty * mark;
  }

  const netPnlUsd = grossPnl - feesUsd + fundingUsd;
  const rMultiple = plan.riskUsd !== 0 ? netPnlUsd / plan.riskUsd : 0;

  return {
    planId: plan.planId,
    ruleId: plan.ruleId,
    symbol: plan.symbol,
    decisionDay,
    entryTime: entryBar.t,
    exitTime,
    entryPrice,
    exitPrice,
    exitKind: finalExitKind,
    netPnlUsd,
    riskUsd: plan.riskUsd,
    rMultiple,
    fundingUsd,
    feesUsd,
  };
}
