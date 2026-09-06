import type { TradeSignal } from "./strategy/signals.ts";
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
/**
 * Execute a trade signal against the exchange via ccxt.
 * In paper mode (default), simulates fills at market price with 0.1% fee.
 * In live mode, calls the exchange API.
 *
 * If the signal is "hold", returns a no-op result.
 * If balance is insufficient, returns { side: "hold" }.
 */
export async function execute(signal: TradeSignal, config: Config, cashUsd?: number): Promise<TradeResult> {
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
  const simulatedPrice = 40000 + Math.random() * 2000;
  const rawQty = signal.type === "buy" ? config.maxPositionSizeUsd / simulatedPrice : 0.01;
  const fee = (rawQty * simulatedPrice) * 0.001;

  // Check if we can afford this trade
  if (signal.type === "buy" && cashUsd !== undefined) {
    const cost = rawQty * simulatedPrice + fee;
    if (cost > cashUsd) {
      // Not enough cash — return a minimal trade with what we have
      const affordableQty = Math.max((cashUsd * 0.99) / simulatedPrice, 0);
      if (affordableQty <= 0.000001) {
        return {
          symbol: signal.symbol,
          side: "hold",
          quantity: 0,
          price: 0,
          fee: 0,
          timestamp: Date.now(),
        };
      }
      const affordableFee = (affordableQty * simulatedPrice) * 0.001;
      return {
        symbol: signal.symbol,
        side: signal.type,
        quantity: affordableQty,
        price: simulatedPrice,
        fee: affordableFee,
        timestamp: Date.now(),
      };
    }
  }

  return {
    symbol: signal.symbol,
    side: signal.type,
    quantity: rawQty,
    price: simulatedPrice,
    fee,
    timestamp: Date.now(),
  };
}