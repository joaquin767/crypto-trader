// Adapters — convert between Bybit API types and the app's internal types.

import type { MarketSnapshot } from "../market.ts";
import type { TradeResult } from "../executor.ts";
import type { Position } from "../portfolio.ts";
import type { BybitTicker, BybitOrderResponse, BybitPosition, BybitWalletBalance } from "./types.ts";

/**
 * Convert a Bybit ticker to the app's MarketSnapshot.
 *
 * The Bybit ticker fields are all strings (to preserve precision).
 * We parse them to numbers for the app's internal types.
 */
export function tickerToMarketSnapshot(ticker: BybitTicker): MarketSnapshot {
  return {
    symbol: bybitSymbolToApp(ticker.symbol),
    price: Number.parseFloat(ticker.lastPrice),
    change24h: Number.parseFloat(ticker.price24hPcnt) * 100, // Bybit returns 0.0158 for 1.58%
    volume24h: Number.parseFloat(ticker.volume24h),
    timestamp: Date.now(),
  };
}

/**
 * Convert a Bybit order response to the app's TradeResult.
 * Only for filled orders; partial fills are handled separately.
 */
export function orderResponseToTradeResult(order: BybitOrderResponse): TradeResult {
  const quantity = Number.parseFloat(order.cumExecQty);
  const side = order.side === "Buy" ? "buy" : order.side === "Sell" ? "sell" : "hold";
  const price = order.avgPrice
    ? Number.parseFloat(order.avgPrice)
    : Number.parseFloat(order.price);
  const fee = Number.parseFloat(order.cumExecFee);

  return {
    symbol: bybitSymbolToApp(order.symbol),
    side,
    quantity,
    price,
    fee,
    timestamp: Number.parseInt(order.createdTime),
  };
}

/**
 * Convert a Bybit position to the app's Position.
 */
export function bybitPositionToPosition(pos: BybitPosition): Position {
  return {
    symbol: bybitSymbolToApp(pos.symbol),
    quantity: Number.parseFloat(pos.size),
    entryPrice: Number.parseFloat(pos.entryPrice),
    currentPrice: Number.parseFloat(pos.markPrice),
  };
}

/**
 * Get the total USD value from wallet balances.
 * This is the user's total balance on Bybit — for display only.
 * The system NEVER uses this as operating capital.
 */
export function walletToTotalUsd(wallets: BybitWalletBalance[]): number {
  return wallets.reduce((sum, w) => sum + Number.parseFloat(w.usdValue || "0"), 0);
}

/**
 * Get the available balance for a specific coin.
 */
export function walletAvailableBalance(wallets: BybitWalletBalance[], coin: string): number {
  const wallet = wallets.find(w => w.coin === coin);
  return wallet ? Number.parseFloat(wallet.availableBalance) : 0;
}

/**
 * Convert app symbol format (BTC/USDT) to Bybit format (BTCUSDT).
 */
export function appSymbolToBybit(symbol: string): string {
  return symbol.replace("/", "");
}

/**
 * Convert Bybit symbol format (BTCUSDT) to app format (BTC/USDT).
 */
export function bybitSymbolToApp(symbol: string): string {
  // Handle common quote currencies
  const match = symbol.match(/^(.*?)(USDT|USDC|USD|BUSD|DAI)$/);
  if (match && match[1] && match[2]) {
    return `${match[1]}/${match[2]}`;
  }
  // If no match, return as-is
  return symbol;
}