import type { Config } from "../config.ts";
import type { Portfolio } from "../portfolio.ts";

/**
 * Calculate position size from risk, not from confidence — see
 * specs/live-trading-readiness.md §9. Previously this scaled position size
 * linearly with the signal's confidence, which meant a stable major pair and
 * a thin, volatile micro-cap got the exact same dollar exposure for the same
 * confidence score, even though their real risk-of-ruin per trade was very
 * different (this is exactly the kind of symbol autoSelectSymbols now
 * actively picks).
 *
 * The position is sized so that a fixed % of maxCapitalUsd
 * (`riskPerTradePercent`) is what's actually at stake if the stop is hit —
 * where "the stop" is the wider of the configured stopLossPercent and
 * ATR-implied volatility (atrStopMultiplier × ATR-as-%-of-price). A volatile
 * symbol with a wide ATR-implied stop gets a smaller position for the same
 * risk budget; a stable one with a tight stop gets a larger one — converging
 * on comparable *risk*, not comparable *notional*.
 */
export function calcPositionSize(
  portfolio: Portfolio,
  config: Config,
  atr: number,
  price: number,
): number {
  const riskPerTradePercent = config.riskPerTradePercent ?? 1;
  const atrStopMultiplier = config.atrStopMultiplier ?? 2;
  const cashReservePercent = config.cashReservePercent ?? 10;

  const riskUsd = config.maxCapitalUsd * (riskPerTradePercent / 100);
  const atrPercent = price > 0 ? (atr / price) * 100 : 0;
  const stopDistancePercent = Math.max(config.stopLossPercent, atrPercent * atrStopMultiplier);

  const positionUsd = riskUsd / (stopDistancePercent / 100);
  const availableCash = portfolio.cashUsd * (1 - cashReservePercent / 100);

  return Math.max(0, Math.min(positionUsd, config.maxPositionSizeUsd, availableCash));
}

/**
 * True if the ATR-implied plausible move at least clears round-trip cost by
 * `minEdgeToFeeRatio`x — resolves F4 (specs/strategy-signal-quality.md §5).
 * A signal that fails this is a coin-flip on direction with a fee that's
 * already larger than the expected move: F3 showed 21/21 closed trades in a
 * live session lost money, 20 of them by almost exactly the round-trip fee,
 * because entries fired on setups whose plausible move never had a chance
 * of clearing costs in the first place.
 */
export function hasPlausibleEdge(
  atr: number, price: number, config: Config, minEdgeToFeeRatio = 2,
): boolean {
  const atrPercent = price > 0 ? (atr / price) * 100 : 0;
  const roundTripFeePercent = config.estimatedRoundTripFeePercent ?? 0.11;
  return atrPercent >= roundTripFeePercent * minEdgeToFeeRatio;
}

/**
 * Calculate max drawdown from a series of portfolio values.
 */
export function calcMaxDrawdown(values: number[]): number {
  if (values.length < 2) return 0;
  let peak = values[0]!;
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100; // as percentage
}

/**
 * Calculate Sharpe ratio from a series of returns.
 */
export function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - avg) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (avg / stdDev) * Math.sqrt(365); // annualized
}

/**
 * Calculate win rate from a series of trade P&Ls.
 */
export function calcWinRate(pnls: number[]): number {
  if (pnls.length === 0) return 0;
  return pnls.filter(p => p > 0).length / pnls.length;
}

/**
 * Calculate profit factor (gross profit / gross loss).
 */
export function calcProfitFactor(pnls: number[]): number {
  const grossProfit = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  return grossLoss === 0 ? grossProfit > 0 ? Infinity : 0 : grossProfit / grossLoss;
}