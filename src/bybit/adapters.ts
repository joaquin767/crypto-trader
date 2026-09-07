// Adapters — convert between Bybit API types and the app's internal types.

import type { MarketSnapshot } from "../market.ts";
import type { TradeResult } from "../executor.ts";
import type { Position } from "../portfolio.ts";
import type { BybitTicker, BybitOrderResponse, BybitPosition, BybitWalletBalance } from "./types.ts";
import { BybitFillUncertainError } from "./types.ts";

/**
 * Convert a Bybit ticker to the app's MarketSnapshot.
 *
 * Handles Bybit Delta WebSocket updates by merging with a previous snapshot
 * if fields are missing or NaN.
 */
export function tickerToMarketSnapshot(
  ticker: Partial<BybitTicker> & { symbol: string },
  previous?: MarketSnapshot,
): MarketSnapshot {
  const symbol = bybitSymbolToApp(ticker.symbol);

  const parsedPrice = ticker.lastPrice ? Number.parseFloat(ticker.lastPrice) : NaN;
  const price = !Number.isNaN(parsedPrice) ? parsedPrice : previous?.price ?? 0;

  const parsedChange = ticker.price24hPcnt ? Number.parseFloat(ticker.price24hPcnt) * 100 : NaN;
  const change24h = !Number.isNaN(parsedChange) ? parsedChange : previous?.change24h ?? 0;

  const parsedVolume = ticker.volume24h ? Number.parseFloat(ticker.volume24h) : NaN;
  const volume24h = !Number.isNaN(parsedVolume) ? parsedVolume : previous?.volume24h ?? 0;

  const parsedHigh = ticker.highPrice24h ? Number.parseFloat(ticker.highPrice24h) : NaN;
  const high24h = !Number.isNaN(parsedHigh) ? parsedHigh : previous?.high24h;

  const parsedLow = ticker.lowPrice24h ? Number.parseFloat(ticker.lowPrice24h) : NaN;
  const low24h = !Number.isNaN(parsedLow) ? parsedLow : previous?.low24h;

  return {
    symbol,
    price,
    change24h,
    volume24h,
    high24h,
    low24h,
    timestamp: Date.now(),
  };
}

/**
 * Convert a Bybit order response to the app's TradeResult.
 * Only for filled orders; partial fills are handled separately.
 *
 * Throws BybitFillUncertainError if the fields we need don't parse to real
 * numbers (e.g. a market order whose execution report hasn't landed yet).
 * Previously this silently returned NaN, which — once applied via
 * portfolio.update() — corrupted cashUsd into NaN for the rest of the session.
 * Callers must not synthesize a trade from an unparseable response; they should
 * poll for the real fill instead (see BybitConnector.placeOrder).
 */
export function orderResponseToTradeResult(order: BybitOrderResponse): TradeResult {
  const quantity = Number.parseFloat(order.cumExecQty);
  const side = order.side === "Buy" ? "buy" : order.side === "Sell" ? "sell" : "hold";
  const price = order.avgPrice
    ? Number.parseFloat(order.avgPrice)
    : Number.parseFloat(order.price);
  const fee = Number.parseFloat(order.cumExecFee);

  if (Number.isNaN(quantity) || Number.isNaN(price) || Number.isNaN(fee)) {
    throw new BybitFillUncertainError(
      `Order ${order.orderId || "?"} (${order.symbol}) returned an unparseable fill ` +
      `(qty="${order.cumExecQty}", price="${order.avgPrice ?? order.price}", fee="${order.cumExecFee}").`,
    );
  }

  const timestamp = Number.parseInt(order.createdTime, 10);

  return {
    symbol: bybitSymbolToApp(order.symbol),
    side,
    quantity,
    price,
    fee,
    timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
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
  if (!symbol || typeof symbol !== "string") return symbol || "";
  // Handle common quote currencies
  const match = symbol.match(/^(.*?)(USDT|USDC|USD|BUSD|DAI)$/);
  if (match && match[1] && match[2]) {
    return `${match[1]}/${match[2]}`;
  }
  // If no match, return as-is
  return symbol;
}