// Trade journal — records every trade with full context for learning.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TradeSignal } from "../strategy/signals.ts";
import type { TradeResult } from "../executor.ts";
import type { Portfolio } from "../portfolio.ts";

export interface TradeRecord {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  entryTime: number;
  exitTime?: number;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  fee: number;
  pnl?: number;
  pnlPercent?: number;
  confidence: number;
  reason: string;
  indicatorsAtEntry: {
    rsi: number;
    momentum: number;
    atr: number;
  };
  status: "open" | "closed";
}

const JOURNAL_FILE = "trade-journal.json";
const _trades: TradeRecord[] = [];
let _nextId = 1;

// Load persisted journal on module init
try {
  const journalPath = join(process.cwd(), JOURNAL_FILE);
  if (existsSync(journalPath)) {
    const raw = JSON.parse(readFileSync(journalPath, "utf-8"));
    if (Array.isArray(raw.trades)) _trades.push(...raw.trades);
    if (typeof raw.nextId === "number") _nextId = raw.nextId;
    const openCount = _trades.filter(t => t.status === "open").length;
    console.log(`[journal] Loaded ${_trades.length} trades (${openCount} open) from disk`);
  }
} catch {
  // First run
}

/** Persist journal to disk. */
function persistJournal(): void {
  try {
    writeFileSync(
      join(process.cwd(), JOURNAL_FILE),
      JSON.stringify({ trades: _trades, nextId: _nextId }, null, 2),
    );
  } catch (err) {
    console.warn(`[journal] Failed to persist: ${(err as Error).message}`);
  }
}

/** Record a new trade entry. */
export function recordEntry(
  signal: TradeSignal,
  result: TradeResult,
): TradeRecord {
  const record: TradeRecord = {
    id: _nextId++,
    symbol: signal.symbol,
    side: result.side as "buy" | "sell",
    entryTime: result.timestamp,
    entryPrice: result.price,
    quantity: result.quantity,
    fee: result.fee,
    confidence: signal.confidence,
    reason: signal.reason,
    indicatorsAtEntry: {
      rsi: signal.indicators.rsi,
      momentum: signal.indicators.momentum,
      atr: signal.indicators.atr,
    },
    status: "open",
  };
  _trades.push(record);
  persistJournal();
  return record;
}

/** Close a trade (record exit price and P&L). */
export function recordExit(
  symbol: string,
  exitPrice: number,
  exitTime: number,
  fee: number,
): TradeRecord | null {
  const openTrade = _trades
    .filter(t => t.symbol === symbol && t.status === "open")
    .pop();
  if (!openTrade) return null;

  openTrade.exitPrice = exitPrice;
  openTrade.exitTime = exitTime;
  openTrade.fee += fee;
  openTrade.status = "closed";

  const gross = (exitPrice - openTrade.entryPrice) * openTrade.quantity;
  openTrade.pnl = gross - openTrade.fee;
  openTrade.pnlPercent = ((exitPrice - openTrade.entryPrice) / openTrade.entryPrice) * 100;

  persistJournal();
  return openTrade;
}

/** Get all recorded trades. */
export function getHistory(): TradeRecord[] {
  return [..._trades];
}

/** Get closed trades only. */
export function getClosedTrades(): TradeRecord[] {
  return _trades.filter(t => t.status === "closed");
}

/** Get open trades only. */
export function getOpenTrades(): TradeRecord[] {
  return _trades.filter(t => t.status === "open");
}

/** Clear all trades (for tests). */
export function clearJournal(): void {
  _trades.length = 0;
  _nextId = 1;
  persistJournal();
}

/**
 * Reconstruct a portfolio from the persisted journal.
 * This recovers open positions from a previous session so the system
 * can properly close them instead of leaving them orphaned.
 *
 * Call this at startup AFTER creating the initial portfolio.
 * Returns the reconstructed portfolio with correct cash and positions.
 */
export function reconstructPortfolio(
  portfolio: Portfolio,
  latestPrices: Map<string, number>,
): Portfolio {
  const openTrades = getOpenTrades();
  const closedTrades = getClosedTrades();

  // Calculate total P&L from closed trades
  const closedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  if (openTrades.length === 0) {
    // No open positions, but there might be closed P&L to carry forward
    if (closedPnl !== 0) {
      const newCash = Math.max(0, portfolio.maxCapitalUsd + closedPnl);
      console.log(`[journal] Carrying forward $${closedPnl.toFixed(2)} P&L from ${closedTrades.length} closed trades`);
      return {
        ...portfolio,
        cashUsd: newCash,
        totalValueUsd: newCash,
      };
    }
    return portfolio;
  }

  console.log(`[journal] Recovering ${openTrades.length} open positions from previous session...`);

  let totalCost = 0;
  const positions: { symbol: string; quantity: number; entryPrice: number; currentPrice: number }[] = [];

  for (const trade of openTrades) {
    if (trade.side !== "buy") continue;

    const currentPrice = latestPrices.get(trade.symbol) ?? trade.entryPrice;
    const cost = trade.quantity * trade.entryPrice + trade.fee;
    totalCost += cost;

    positions.push({
      symbol: trade.symbol,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      currentPrice,
    });
  }

  // Cash = starting capital + P&L from closed trades - cost of open positions
  const cashUsd = Math.max(0, portfolio.maxCapitalUsd + closedPnl - totalCost);
  const totalValueUsd = cashUsd + positions.reduce((sum, p) => sum + p.quantity * p.currentPrice, 0);

  return {
    positions,
    totalValueUsd,
    cashUsd,
    dailyTradeCount: portfolio.dailyTradeCount,
    maxCapitalUsd: portfolio.maxCapitalUsd,
  };
}