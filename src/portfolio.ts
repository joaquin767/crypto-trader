import type { TradeResult } from "./executor.ts";

export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
}

export interface Portfolio {
  positions: Position[];
  totalValueUsd: number;
  cashUsd: number;
  dailyTradeCount: number;
}

/** Create an empty portfolio. */
export function empty(): Portfolio {
  return { positions: [], totalValueUsd: 0, cashUsd: 10000, dailyTradeCount: 0 };
}

/**
 * Update portfolio after a trade result.
 * For "buy": adds a new position.
 * For "sell": removes the position and adds proceeds to cash.
 * For "hold": no change (except updating current prices if provided).
 */
export function update(portfolio: Portfolio, trade: TradeResult): Portfolio {
  if (trade.side === "hold") {
    // Just update current prices for all positions
    return {
      ...portfolio,
      positions: portfolio.positions.map((p) => ({
        ...p,
        currentPrice: trade.price > 0 ? trade.price : p.currentPrice,
      })),
    };
  }

  if (trade.side === "buy") {
    const newPosition: Position = {
      symbol: trade.symbol,
      quantity: trade.quantity,
      entryPrice: trade.price,
      currentPrice: trade.price,
    };
    const newCash = portfolio.cashUsd - trade.quantity * trade.price - trade.fee;
    return {
      positions: [...portfolio.positions, newPosition],
      totalValueUsd: portfolio.cashUsd + trade.quantity * trade.price,
      cashUsd: Math.max(newCash, 0),
      dailyTradeCount: portfolio.dailyTradeCount + 1,
    };
  }

  // "sell"
  const remaining = portfolio.positions.filter((p) => p.symbol !== trade.symbol);
  const sold = portfolio.positions.find((p) => p.symbol === trade.symbol);
  const proceeds = sold ? sold.quantity * trade.price - trade.fee : 0;
  return {
    positions: remaining,
    totalValueUsd: portfolio.cashUsd + proceeds,
    cashUsd: portfolio.cashUsd + proceeds,
    dailyTradeCount: portfolio.dailyTradeCount + 1,
  };
}