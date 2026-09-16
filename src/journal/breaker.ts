// Journal-driven circuit breaker — specs/daily-catalyst-manual-trading.md §5.8a ("Breaker from
// the journal").
//
// Pure: replays closed `bybit-live` trades (paper trades never count — only real capital is at
// risk) through the existing src/risk/circuit-breaker.ts primitives (E8), in exit-time order.
// Two checkEquityBreakers calls per trade at that trade's OWN exit time (pre-trade equity, then
// post-trade equity) — see the file-level comment in the spec for why post-trade-only would hide
// the first loss of a UTC day from the daily-loss basis (day rollover resets `dayStartEquity` to
// whatever equity is passed in). Latching: `dailyLoss` holds only for the UTC date it tripped on;
// `drawdown`/`consecutiveLosses` hold forever once tripped, until `breakerResetAt` re-baselines
// the whole replay from that instant (dropping every trade at or before it out of the replay, and
// therefore out of the latch).

import {
  checkConsecutiveLosses, checkEquityBreakers, createCircuitBreakerState, recordTradeOutcome,
} from "../risk/circuit-breaker.ts";
import type { CircuitBreakerConfig, CircuitBreakerTrigger } from "../risk/circuit-breaker.ts";
import { lastExitTime, netPnlUsdOf } from "./trade-analytics.ts";
import type { ManualTrade } from "./types.ts";

/** `cbConfig` carries `breakerResetAt` alongside the existing circuit-breaker config fields
 *  (src/config.ts:24-28) — the spec's `computeBreaker(trades, cbConfig, maxCapitalUsd, now)`
 *  signature has no separate slot for it, so it travels in the same per-run resolved bag. */
export interface BreakerConfig extends CircuitBreakerConfig {
  /** Epoch ms, or null (never reset). From `manual.breakerResetAt` (§5.11), parsed by the caller. */
  breakerResetAt: number | null;
}

export interface BreakerResult {
  tripped: boolean;
  trigger: CircuitBreakerTrigger | null;
  details: string;
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Pure. See file header for the full derivation. */
export function computeBreaker(
  trades: readonly ManualTrade[],
  cbConfig: BreakerConfig,
  maxCapitalUsd: number,
  now: number,
): BreakerResult {
  const closed = trades
    .filter((t) => t.venue === "bybit-live" && t.status === "closed")
    .map((t) => ({ trade: t, exitTime: lastExitTime(t), netPnl: netPnlUsdOf(t) }))
    .sort((a, b) => a.exitTime - b.exitTime || a.trade.id.localeCompare(b.trade.id));

  const resetAt = cbConfig.breakerResetAt;
  const before = resetAt === null ? [] : closed.filter((c) => c.exitTime <= resetAt);
  const after = resetAt === null ? closed : closed.filter((c) => c.exitTime > resetAt);

  const equityAtReset = maxCapitalUsd + before.reduce((sum, c) => sum + c.netPnl, 0);
  const initialEquity = resetAt !== null ? equityAtReset : maxCapitalUsd;
  const initialTime = resetAt ?? (after[0]?.exitTime ?? now);

  let state = createCircuitBreakerState(initialEquity, initialTime);
  let cumulativeEquity = initialEquity;
  const events: { trigger: CircuitBreakerTrigger; at: number; details: string }[] = [];

  for (const { exitTime, netPnl } of after) {
    const pre = checkEquityBreakers(state, cbConfig, cumulativeEquity, maxCapitalUsd, exitTime);
    state = pre.state;
    if (pre.trip) events.push(pre.trip);

    cumulativeEquity += netPnl;
    const post = checkEquityBreakers(state, cbConfig, cumulativeEquity, maxCapitalUsd, exitTime);
    state = post.state;
    if (post.trip) events.push(post.trip);

    state = recordTradeOutcome(state, netPnl);
    const consec = checkConsecutiveLosses(state, cbConfig, exitTime);
    if (consec) events.push(consec);
  }

  const final = checkEquityBreakers(state, cbConfig, cumulativeEquity, maxCapitalUsd, now);
  if (final.trip) events.push(final.trip);
  const finalConsec = checkConsecutiveLosses(final.state, cbConfig, now);
  if (finalConsec) events.push(finalConsec);

  const today = utcDateString(now);
  const active = events.filter((e) => (e.trigger === "dailyLoss" ? utcDateString(e.at) === today : true));

  if (active.length === 0) return { tripped: false, trigger: null, details: "" };
  const earliest = active.reduce((a, b) => (a.at <= b.at ? a : b));
  return { tripped: true, trigger: earliest.trigger, details: earliest.details };
}
