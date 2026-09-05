// Trade journal — records every trade with full context for learning.

import type { TradeSignal } from "../strategy/signals.ts";
import type { TradeResult } from "../executor.ts";

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
  pnl?: number;           // realized P&L on exit
  pnlPercent?: number;    // P&L as percentage
  confidence: number;
  reason: string;
  indicatorsAtEntry: {
    rsi: number;
    momentum: number;
    atr: number;
  };
  // For buy trades, the exit is recorded later when position is closed
  status: "open" | "closed";
}

const _trades: TradeRecord[] = [];
let _nextId = 1;

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
}