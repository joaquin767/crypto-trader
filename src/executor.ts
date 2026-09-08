import type { TradeSignal } from "./strategy/signals.ts";
import type { Config } from "./config.ts";
import type { Portfolio } from "./portfolio.ts";
import type { MarketSnapshot } from "./market.ts";

export interface TradeResult {
  symbol: string;
  side: "buy" | "sell" | "hold";
  quantity: number;
  price: number;
  fee: number;
  timestamp: number;
}

/**
 * Simulate a trade fill at the real current market price, with a configurable
 * simulated fee (0.1%). This is the standalone no-exchange paper-trading path —
 * it must never run as a silent substitute for a real Bybit order (see
 * specs/live-trading-readiness.md §6.1/§6.2): a previous version fabricated a
 * random $40,000-42,000 price regardless of the actual symbol, and a hardcoded
 * 0.01 sell quantity regardless of what was actually held, which — when this
 * function ran as an automatic fallback after a rejected live order — could
 * silently mark a real position "closed" in the local books at a fantasy price
 * while it stayed open and unmanaged on the exchange.
 *
 * `positionUsd` is the caller's already-sized position (from
 * `calcPositionSize()`), so paper-mode sizing matches live-mode sizing exactly.
 * For a sell, quantity is always the actual held quantity from `portfolio` —
 * never a guess.
 */
export async function execute(
  signal: TradeSignal,
  config: Config,
  portfolio: Portfolio,
  snapshot: MarketSnapshot,
  positionUsd: number,
): Promise<TradeResult> {
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

  const price = snapshot.price;
  // Per-side simulated fee. Defaults to Bybit's standard non-VIP linear
  // perpetual TAKER rate (0.055%), measured from real fills in
  // tests/fixtures/apt-usdt-session-2026-09-07.json — not the 0.1% that was
  // hardcoded here before, which overstated round-trip cost by ~2x and made
  // every paper trade and every backtest look worse than reality. Override
  // via config.simulatedFeePercentPerSide (e.g. 0.02 for maker/post-only).
  const FEE_RATE = (config.simulatedFeePercentPerSide ?? 0.055) / 100;

  if (signal.type === "sell") {
    const existing = portfolio.positions.find(p => p.symbol === signal.symbol);
    const quantity = existing?.quantity ?? 0;
    if (quantity <= 0) {
      return { symbol: signal.symbol, side: "hold", quantity: 0, price: 0, fee: 0, timestamp: Date.now() };
    }
    const fee = quantity * price * FEE_RATE;
    return { symbol: signal.symbol, side: "sell", quantity, price, fee, timestamp: Date.now() };
  }

  // "buy"
  const rawQty = positionUsd / price;
  const fee = rawQty * price * FEE_RATE;
  const cost = rawQty * price + fee;

  if (cost > portfolio.cashUsd) {
    // Not enough cash for the full sized position — buy what's affordable instead.
    const affordableQty = Math.max((portfolio.cashUsd * 0.99) / price, 0);
    if (affordableQty <= 0.000001) {
      return { symbol: signal.symbol, side: "hold", quantity: 0, price: 0, fee: 0, timestamp: Date.now() };
    }
    const affordableFee = affordableQty * price * FEE_RATE;
    return { symbol: signal.symbol, side: "buy", quantity: affordableQty, price, fee: affordableFee, timestamp: Date.now() };
  }

  return { symbol: signal.symbol, side: "buy", quantity: rawQty, price, fee, timestamp: Date.now() };
}
