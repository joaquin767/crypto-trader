import type { TradeSignal } from "./strategy/signals.ts";
import type { Config } from "./config.ts";
import type { Portfolio } from "./portfolio.ts";
import type { MarketSnapshot } from "./market.ts";
import { classifyExitReason } from "./strategy/exit-reason.ts";

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
  // Stamp trades with the time of the SNAPSHOT being acted on, not the wall
  // clock. Live these are the same thing. In a backtest replaying historical
  // candles they are ~a year apart, and using Date.now() set every position's
  // openedAt to "today" while snapshot.timestamp stayed in the past — so
  // `ageMs = snapshot.timestamp - position.openedAt` was NEGATIVE and the
  // model's horizon exit (signals.ts modelHorizonMsFor) could never fire.
  // The result: no backtest this project has ever run modelled the horizon
  // exit at all, while live did. See specs/profit-target-roadmap.md §2.5.
  const tradeTime = snapshot.timestamp;
  if (signal.type === "hold") {
    return {
      symbol: signal.symbol,
      side: "hold",
      quantity: 0,
      price: 0,
      fee: 0,
      timestamp: tradeTime,
    };
  }

  const price = snapshot.price;
  // Maker and taker are charged separately, per leg. Charging one blended
  // rate to both sides understated the real round trip by nearly half and
  // flattered every backtest.
  //
  // Confirmed against real testnet fills on 2026-09-08: post-only entry
  // 0.0200%, market exit 0.0548%, round trip 0.0749%.
  //
  // A sell earns the maker rate only when it is a TAKE-PROFIT and post-only
  // take-profit exits are enabled. A resting limit sell above the market is a
  // maker order by construction, so this costs nothing in realism. Stop-loss
  // and horizon exits stay taker unconditionally — see
  // config.usePostOnlyTakeProfitExits for why that is an invariant and not a
  // tunable. classifyExitReason() falls back to "reconciled" for anything it
  // does not recognise, so an unattributed close can never sneak into the
  // cheaper bucket.
  const isMakerFill =
    (signal.type === "buy" && (config.usePostOnlyEntries ?? false)) ||
    (signal.type === "sell"
      && (config.usePostOnlyTakeProfitExits ?? false)
      && classifyExitReason(signal.reason) === "take_profit");
  const FEE_RATE = (isMakerFill
    ? (config.simulatedMakerFeePercent ?? 0.02)
    : (config.simulatedTakerFeePercent ?? 0.055)) / 100;

  if (signal.type === "sell") {
    const existing = portfolio.positions.find(p => p.symbol === signal.symbol);
    const quantity = existing?.quantity ?? 0;
    if (quantity <= 0) {
      return { symbol: signal.symbol, side: "hold", quantity: 0, price: 0, fee: 0, timestamp: tradeTime };
    }
    const fee = quantity * price * FEE_RATE;
    return { symbol: signal.symbol, side: "sell", quantity, price, fee, timestamp: tradeTime };
  }

  // "buy"
  const rawQty = positionUsd / price;
  const fee = rawQty * price * FEE_RATE;
  const cost = rawQty * price + fee;

  if (cost > portfolio.cashUsd) {
    // Not enough cash for the full sized position — buy what's affordable instead.
    const affordableQty = Math.max((portfolio.cashUsd * 0.99) / price, 0);
    if (affordableQty <= 0.000001) {
      return { symbol: signal.symbol, side: "hold", quantity: 0, price: 0, fee: 0, timestamp: tradeTime };
    }
    const affordableFee = affordableQty * price * FEE_RATE;
    return { symbol: signal.symbol, side: "buy", quantity: affordableQty, price, fee: affordableFee, timestamp: tradeTime };
  }

  return { symbol: signal.symbol, side: "buy", quantity: rawQty, price, fee, timestamp: tradeTime };
}
