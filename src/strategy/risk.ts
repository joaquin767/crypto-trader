import type { Config } from "../config.ts";
import type { Portfolio } from "../portfolio.ts";

/**
 * Calculate optimal position size using the Kelly Criterion.
 *
 * Kelly % = edge / odds = (winRate * avgWin - lossRate * avgLoss) / (avgWin)
 *
 * We use a simplified version: fraction = confidence * (winRate / lossRate) adjusted for volatility.
 * The result is always capped by config.maxPositionSizeUsd and available cash.
 */
export function calcPositionSize(
  confidence: number,          // 0-1, from the signal generator
  portfolio: Portfolio,
  config: Config,
): number {
  // Kelly fraction: use confidence as a proxy for edge
  const kellyFraction = Math.max(0, (confidence - 0.5) * 2); // 0 at 50% conf, 1 at 100% conf

  // Available cash (keep 10% reserve for fees)
  const availableCash = portfolio.cashUsd * 0.9;

  // Kelly-optimal bet size
  const kellyAmount = availableCash * kellyFraction;

  // Apply max position size cap
  const cappedAmount = Math.min(kellyAmount, config.maxPositionSizeUsd);

  // Final: min of capped Kelly amount and available cash
  return Math.min(cappedAmount, availableCash);
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