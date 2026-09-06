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
  /** 🔒 The user-defined operating capital cap. NEVER exceeded. */
  maxCapitalUsd: number;
}

/**
 * Create a portfolio with the user's defined operating capital.
 * The user says "I want to operate with X dollars" via config.maxCapitalUsd.
 * This is the FUNDAMENTAL CASH GUARDRAIL — the system NEVER exceeds this amount.
 * Cash is added ONLY by the user, never by the agent.
 *
 * @param maxCapitalUsd - the user-defined operating capital limit
 */
export function create(maxCapitalUsd: number): Portfolio {
  return {
    positions: [],
    totalValueUsd: maxCapitalUsd,
    cashUsd: maxCapitalUsd,
    dailyTradeCount: 0,
    maxCapitalUsd,
  };
}

/**
 * Update portfolio after a trade result.
 * For "buy": adds a new position, deducts cash (never below 0).
 * For "sell": removes the position, adds proceeds to cash.
 * For "hold": no change (except updating current prices if provided).
 */
export function update(portfolio: Portfolio, trade: TradeResult): Portfolio {
  if (trade.side === "hold") {
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
    const cost = trade.quantity * trade.price + trade.fee;
    const newCash = portfolio.cashUsd - cost;
    return {
      positions: [...portfolio.positions, newPosition],
      totalValueUsd: newCash + cost,
      cashUsd: Math.max(newCash, 0),
      dailyTradeCount: portfolio.dailyTradeCount + 1,
      maxCapitalUsd: portfolio.maxCapitalUsd,
    };
  }

  // "sell"
  const remaining = portfolio.positions.filter((p) => p.symbol !== trade.symbol);
  const sold = portfolio.positions.find((p) => p.symbol === trade.symbol);
  const proceeds = sold ? sold.quantity * trade.price - trade.fee : 0;
  const newCash = portfolio.cashUsd + proceeds;

  return {
    positions: remaining,
    totalValueUsd: newCash,
    cashUsd: newCash,
    dailyTradeCount: portfolio.dailyTradeCount + 1,
    maxCapitalUsd: portfolio.maxCapitalUsd,
  };
}

/**
 * 🔒 Cash guardrail check: is there enough operating capital for a potential trade?
 * The system NEVER exceeds $portfolio.maxCapitalUsd.
 */
export function canAfford(portfolio: Portfolio, costUsd: number): boolean {
  return costUsd <= portfolio.cashUsd && portfolio.cashUsd > 0;
}

/**
 * Progress of how much of the operating capital is deployed (0-1).
 * 0 = all cash available, 1 = all deployed in positions.
 */
/**
 * Progress of how much of the operating capital is deployed (0-1).
 * 0 = all cash available, 1 = all deployed in positions.
 */
export function deploymentRatio(portfolio: Portfolio): number {
  if (portfolio.maxCapitalUsd <= 0) return 0;
  return 1 - (portfolio.cashUsd / portfolio.maxCapitalUsd);
}

/**
 * @deprecated Use `create(maxCapitalUsd)` for real usage. Kept for test compatibility.
 * Creates a portfolio with $1000 operating capital.
 */
export function empty(): Portfolio {
  return create(1000);
}