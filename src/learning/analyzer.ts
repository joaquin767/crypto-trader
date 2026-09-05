// Performance analyzer — calculates metrics from the trade journal.

import { getClosedTrades } from "./journal.ts";
import { calcWinRate, calcSharpe, calcProfitFactor, calcMaxDrawdown } from "../strategy/risk.ts";

export interface PerformanceReport {
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  winRate: number;
  totalPnl: number;
  totalPnlPercent: number;
  sharpeRatio: number;
  profitFactor: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgConfidence: number;
  winRateBySymbol: Record<string, { wins: number; losses: number; rate: number }>;
  portfolioValues: number[];  // for equity curve
}

/**
 * Analyze the full trade journal and return comprehensive performance metrics.
 * Call this periodically to feed the learning system.
 */
export function analyze(initialCash: number): PerformanceReport {
  const closed = getClosedTrades();
  const allPnls = closed.map(t => t.pnl ?? 0);
  const wins = allPnls.filter(p => p > 0);
  const losses = allPnls.filter(p => p < 0);

  // Win rate by symbol
  const bySymbol: Record<string, { wins: number; losses: number }> = {};
  for (const t of closed) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins: 0, losses: 0 };
    if ((t.pnl ?? 0) > 0) bySymbol[t.symbol]!.wins++;
    else bySymbol[t.symbol]!.losses++;
  }
  const winRateBySymbol: Record<string, { wins: number; losses: number; rate: number }> = {};
  for (const [sym, v] of Object.entries(bySymbol)) {
    winRateBySymbol[sym] = {
      ...v,
      rate: v.wins / Math.max(v.wins + v.losses, 1),
    };
  }

  // Portfolio values for drawdown
  const portfolioValues: number[] = [initialCash];
  let runningCash = initialCash;
  for (const t of closed) {
    runningCash += t.pnl ?? 0;
    portfolioValues.push(runningCash);
  }

  return {
    totalTrades: getClosedTrades().length + (closed.length > 0 ? 0 : 0),
    closedTrades: closed.length,
    openTrades: closed.length > 0 ? 0 : 0,  // simplified
    winRate: calcWinRate(allPnls),
    totalPnl: allPnls.reduce((a, b) => a + b, 0),
    totalPnlPercent: initialCash > 0 ? (allPnls.reduce((a, b) => a + b, 0) / initialCash) * 100 : 0,
    sharpeRatio: calcSharpe(allPnls.map(p => p / initialCash)),
    profitFactor: calcProfitFactor(allPnls),
    maxDrawdown: calcMaxDrawdown(portfolioValues),
    avgWin: wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    largestWin: wins.length > 0 ? Math.max(...wins) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses) : 0,
    avgConfidence: closed.length > 0
      ? closed.reduce((a, t) => a + t.confidence, 0) / closed.length
      : 0,
    winRateBySymbol,
    portfolioValues,
  };
}