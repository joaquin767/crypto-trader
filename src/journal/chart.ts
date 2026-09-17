// Trade chart & replay — pure calculations, specs/daily-catalyst-manual-trading.md §5.14.
//
// No I/O: everything here is a function of already-fetched Kline arrays and a ManualTrade. The
// caller (src/server/journal-server.ts) picks the interval via `chooseInterval`, fetches candles
// and daily bars through src/journal/market-data.ts, and passes the result into
// `buildTradeChartData`. Fail closed (P1): insufficient inputs (too few daily bars before entry,
// no usable last price) omit that part of the output (`band: null`, `pnl: null`) rather than
// guessing or interpolating.

import type { Kline } from "../research/types.ts";
import type { ManualTrade, ManualTradeVenue } from "./types.ts";
import { firstEntryTime, lastExitTime, netPnlUsdOf } from "./trade-analytics.ts";

export type ChartInterval = "15" | "60";

export const INTERVAL_MS: Record<ChartInterval | "D", number> = {
  "15": 15 * 60_000,
  "60": 60 * 60_000,
  D: 24 * 60 * 60_000,
};

const HOURS_48_MS = 48 * 60 * 60_000;

/** Pure. `"15"` when `(exitTime ?? now) − firstEntry <= 48h`, else `"60"` (AC-72). */
export function chooseInterval(firstEntryMs: number, endMs: number): ChartInterval {
  return endMs - firstEntryMs <= HOURS_48_MS ? "15" : "60";
}

/** Pure. Sample stdev (n−1) of the last 7 daily log returns, using only daily bars whose close
 *  time (`t + 24h`) is at or before `entryTimeMs` — later bars (even same-day bars still forming
 *  when the trade was entered) never leak into a "before entry" volatility estimate. Fewer than
 *  8 eligible bars → null: the band is omitted rather than computed from too little history
 *  (AC-69). */
export function dailySigmaBeforeEntry(dailyBars: readonly Kline[], entryTimeMs: number): number | null {
  const eligible = dailyBars
    .filter((b) => b.t + INTERVAL_MS.D <= entryTimeMs)
    .slice()
    .sort((a, b) => a.t - b.t);
  if (eligible.length < 8) return null;
  const last8 = eligible.slice(-8);
  const logReturns: number[] = [];
  for (let i = 1; i < last8.length; i++) logReturns.push(Math.log(last8[i]!.c / last8[i - 1]!.c));
  const n = logReturns.length;
  const mean = logReturns.reduce((sum, v) => sum + v, 0) / n;
  const variance = logReturns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

export interface VolatilityBandPoint {
  t: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
}

/** Pure. For each `t >= entryTime`: `d = (t − entryTime) / 24h`, `upper_k = entry·e^(k·σ·√d)`,
 *  `lower_k = entry·e^(−k·σ·√d)`, `k ∈ {1, 2}`. Carries no direction and is not a forecast — it
 *  is only the historical daily volatility observed strictly before entry, projected forward as
 *  a symmetric range (AC-70). */
export function volatilityBand(
  entryPrice: number,
  entryTimeMs: number,
  sigmaDaily: number,
  times: readonly number[],
): VolatilityBandPoint[] {
  return times
    .filter((t) => t >= entryTimeMs)
    .map((t) => {
      const sqrtD = Math.sqrt((t - entryTimeMs) / INTERVAL_MS.D);
      return {
        t,
        upper1: entryPrice * Math.exp(sigmaDaily * sqrtD),
        lower1: entryPrice * Math.exp(-sigmaDaily * sqrtD),
        upper2: entryPrice * Math.exp(2 * sigmaDaily * sqrtD),
        lower2: entryPrice * Math.exp(-2 * sigmaDaily * sqrtD),
      };
    });
}

/** Pure. Candles at or before `cursor` are revealed; later ones hidden. `cursor` is clamped to
 *  `[0, candles.length − 1]` (AC-74). */
export function revealCandles<T>(candles: readonly T[], cursor: number): T[] {
  if (candles.length === 0) return [];
  const clamped = Math.max(0, Math.min(cursor, candles.length - 1));
  return candles.slice(0, clamped + 1);
}

// ── buildTradeChartData (§5.14) ─────────────────────────────────────────────────────────────────

export interface TradeChartData {
  tradeId: string;
  symbol: string;
  side: "long" | "short";
  venue: ManualTradeVenue;
  status: "open" | "closed";
  origin: "rules-file" | "ai-analyst" | null;
  ruleId: string | null;
  leverage: number | null; // actualLeverage for bybit-live, plannedSnapshot.leverage for paper
  interval: ChartInterval;
  levels: { entry: number; stop: number | null; target: number | null; liquidation: number | null };
  entryTime: number;
  exitTime: number | null;
  exitPrice: number | null;
  candles: Kline[]; // closed bars from firstEntry − 6 bars to (lastExit + 6 bars | now)
  formingCandle: Kline | null; // open trades only: the current, not-yet-closed bar (drawn dashed)
  band: { sigmaDaily: number; points: VolatilityBandPoint[] } | null;
  pnl: { kind: "realized" | "unrealized"; usd: number; basis: string } | null;
  dataStatus: "ok" | "unavailable";
  dataDetail: string;
}

export interface BuildTradeChartInput {
  /** Ascending klines at `interval`; only needs to cover (at least) the 6-bar window — this
   *  function trims to it, so a caller that fetched a wider range is safe to pass through as-is. */
  candles: readonly Kline[];
  formingCandle: Kline | null;
  /** Daily bars usable by `dailySigmaBeforeEntry`; extra bars (including ones after entry) are
   *  filtered internally. */
  dailyBars: readonly Kline[];
  /** Live sync mark price for `bybit-live`; null when unavailable, stale, or venue is `paper`. */
  markPrice: number | null;
  markStale: boolean;
  now: number;
  interval: ChartInterval;
  dataStatus: "ok" | "unavailable";
  dataDetail: string;
}

function weightedAvgPrice(fills: readonly { qty: number; price: number }[]): number | null {
  const qty = fills.reduce((sum, f) => sum + f.qty, 0);
  return qty === 0 ? null : fills.reduce((sum, f) => sum + f.qty * f.price, 0) / qty;
}

function sumQty(fills: readonly { qty: number }[]): number {
  return fills.reduce((sum, f) => sum + f.qty, 0);
}

function sumFees(t: ManualTrade): number {
  return [...t.entryFills, ...t.exitFills].reduce((sum, f) => sum + f.feeUsd, 0);
}

/** Pure. Assembles the full chart payload for one trade exactly per §5.14: levels from
 *  `plannedSnapshot` (liquidation from `exchangeLiqPrice` for a live trade, else the plan's
 *  `estLiquidationPrice`), the candle window `firstEntry − 6 bars .. lastExit + 6 bars | now`,
 *  and the realized/unrealized P&L rules. `input.candles` is trimmed to that window here so a
 *  caller that over-fetches never leaks extra bars into the output. */
export function buildTradeChartData(trade: ManualTrade, input: BuildTradeChartInput): TradeChartData {
  const plan = trade.plannedSnapshot;
  const barMs = INTERVAL_MS[input.interval];
  const entryTime = firstEntryTime(trade);
  const lastExitRaw = lastExitTime(trade);
  const exitTime = trade.status === "closed" && lastExitRaw > 0 ? lastExitRaw : null;
  const endBound = exitTime ?? input.now;

  const windowStart = entryTime - 6 * barMs;
  const windowEnd = endBound + 6 * barMs;
  const candles = input.candles
    .filter((k) => k.t >= windowStart && k.t <= windowEnd)
    .slice()
    .sort((a, b) => a.t - b.t);

  const avgEntryPrice = weightedAvgPrice(trade.entryFills);
  const avgExitPrice = trade.status === "closed" ? weightedAvgPrice(trade.exitFills) : null;
  // The real point the trade started from — actual fills over the plan's reference price,
  // falling back to the plan only for an unplanned/fill-less trade (never guessed further).
  const anchorEntryPrice = avgEntryPrice ?? plan?.referencePrice ?? 0;

  const liquidation = trade.venue === "bybit-live"
    ? (trade.exchangeLiqPrice ?? plan?.estLiquidationPrice ?? null)
    : (plan?.estLiquidationPrice ?? null);

  const levels = {
    entry: plan?.referencePrice ?? anchorEntryPrice,
    stop: plan?.stopPrice ?? null,
    target: plan?.targetPrice ?? null,
    liquidation,
  };

  const leverage = trade.venue === "bybit-live" ? trade.actualLeverage : (plan?.leverage ?? null);

  const sigmaDaily = dailySigmaBeforeEntry(input.dailyBars, entryTime);
  const bandTimes = candles.map((k) => k.t).concat(input.formingCandle ? [input.formingCandle.t] : []);
  const band = sigmaDaily !== null
    ? { sigmaDaily, points: volatilityBand(anchorEntryPrice, entryTime, sigmaDaily, bandTimes) }
    : null;

  let pnl: TradeChartData["pnl"] = null;
  if (trade.status === "closed") {
    pnl = { kind: "realized", usd: netPnlUsdOf(trade), basis: "realized" };
  } else if (avgEntryPrice !== null) {
    let lastPrice: number | null = null;
    let basis = "";
    if (trade.venue === "bybit-live" && input.markPrice !== null && !input.markStale) {
      lastPrice = input.markPrice;
      basis = "mark";
    } else {
      const lastClosed = candles.at(-1) ?? null;
      if (lastClosed) {
        lastPrice = lastClosed.c;
        basis = input.interval === "15" ? "last 15m close" : "last 1h close";
      }
    }
    if (lastPrice !== null) {
      const qty = sumQty(trade.entryFills);
      const fees = sumFees(trade);
      const directional = trade.side === "long" ? lastPrice - avgEntryPrice : avgEntryPrice - lastPrice;
      pnl = { kind: "unrealized", usd: directional * qty - fees + trade.fundingUsd, basis };
    }
  }

  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    venue: trade.venue,
    status: trade.status,
    origin: plan?.origin ?? null,
    ruleId: trade.ruleId,
    leverage,
    interval: input.interval,
    levels,
    entryTime,
    exitTime,
    exitPrice: avgExitPrice,
    candles,
    formingCandle: input.formingCandle,
    band,
    pnl,
    dataStatus: input.dataStatus,
    dataDetail: input.dataDetail,
  };
}
