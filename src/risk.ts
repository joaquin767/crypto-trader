import type { MarketSnapshot } from "./market.ts";
import type { Portfolio } from "./portfolio.ts";
import type { Config } from "./config.ts";

export type SignalType = "buy" | "sell" | "hold";

export interface TradeSignal {
  type: SignalType;
  symbol: string;
  confidence: number;   // 0-1
  reason: string;
}

/**
 * Evaluate a market snapshot against the portfolio and risk thresholds.
 * Returns a TradeSignal: "buy" if conditions are favorable, "sell" if stop-loss or
 * take-profit is triggered, "hold" otherwise.
 */
export function evaluate(
  snapshot: MarketSnapshot,
  portfolio: Portfolio,
  config: Config,
): TradeSignal {
  // Check max daily trades
  if (config.maxDailyTrades > 0 && portfolio.dailyTradeCount >= config.maxDailyTrades) {
    return { type: "hold", symbol: snapshot.symbol, confidence: 1, reason: "maxDailyTrades reached" };
  }

  // Check if we already have a position in this symbol
  const existing = portfolio.positions.find((p) => p.symbol === snapshot.symbol);

  if (existing) {
    // Stop-loss check
    const lossPercent = ((existing.currentPrice - snapshot.price) / existing.currentPrice) * 100;
    if (lossPercent >= config.stopLossPercent) {
      return {
        type: "sell",
        symbol: snapshot.symbol,
        confidence: Math.min(0.8 + lossPercent / 100, 1),
        reason: `stop-loss triggered: ${lossPercent.toFixed(1)}% drop`,
      };
    }

    // Take-profit check
    const profitPercent = ((snapshot.price - existing.currentPrice) / existing.currentPrice) * 100;
    if (profitPercent >= config.takeProfitPercent) {
      return {
        type: "sell",
        symbol: snapshot.symbol,
        confidence: Math.min(0.8 + profitPercent / 100, 1),
        reason: `take-profit triggered: ${profitPercent.toFixed(1)}% gain`,
      };
    }

    return { type: "hold", symbol: snapshot.symbol, confidence: 0.5, reason: "position held within thresholds" };
  }

  // No position — check if we can buy (position size check)
  const tradeValue = snapshot.price * 0.01; // example: buy 0.01 BTC
  if (tradeValue > config.maxPositionSizeUsd) {
    return { type: "hold", symbol: snapshot.symbol, confidence: 0.3, reason: "position exceeds maxPositionSizeUsd" };
  }

  // Simple buy signal: positive momentum
  if (snapshot.change24h > 1 && snapshot.change24h < 15) {
    return {
      type: "buy",
      symbol: snapshot.symbol,
      confidence: Math.min(0.5 + snapshot.change24h / 20, 1),
      reason: `positive 24h change: ${snapshot.change24h.toFixed(1)}%`,
    };
  }

  return { type: "hold", symbol: snapshot.symbol, confidence: 0.2, reason: "no favorable conditions" };
}