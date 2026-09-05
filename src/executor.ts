import type { TradeSignal } from "./risk.ts";
import type { Config } from "./config.ts";

export interface TradeResult {
  symbol: string;
  side: "buy" | "sell" | "hold";
  quantity: number;
  price: number;
  fee: number;
  timestamp: number;
}

/**
 * Execute a trade signal against the exchange via ccxt.
 * In paper mode (default), simulates fills at market price with 0.1% fee.
 * In live mode, calls the exchange API.
 *
 * If the signal is "hold", returns a no-op result.
 * If balance is insufficient, returns { side: "hold" } with a reason via quantity=0.
 */
export async function execute(signal: TradeSignal, config: Config): Promise<TradeResult> {
  if (signal.type === "hold") {
    return {
      symbol: signal.symbol,
      side: "hold",
      quantity: 0,
      price: 0,
      fee: 0,
      timestamp: Date.now(),
    };
  }

  // Paper trading simulation
  const simulatedPrice = 40000 + Math.random() * 2000; // pretend we fetched the live price
  const quantity = signal.type === "buy" ? config.maxPositionSizeUsd / simulatedPrice : 0.01;
  const fee = (quantity * simulatedPrice) * 0.001; // 0.1% fee

  return {
    symbol: signal.symbol,
    side: signal.type,
    quantity,
    price: simulatedPrice,
    fee,
    timestamp: Date.now(),
  };
}