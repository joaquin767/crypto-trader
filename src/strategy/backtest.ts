// Offline backtesting harness — specs/strategy-signal-quality.md §6 (resolves
// F5, unblocks F8). Replays the REAL analyze()/execute() strategy engine
// against real historical candles, so a strategy change can be validated for
// non-negative expectancy net of fees before it's ever trusted with real
// capital again — design principle 4. Never calls any exchange write
// endpoint and never touches the live journal; candles must come from a real
// source (e.g. RestClient.getKline(), src/bybit/rest.ts:128) fetched once and
// cached to a fixture, never fabricated and never fetched live inside a test.

import { analyze, clearHistory } from "./signals.ts";
import { clearCandles, seedCandles } from "./candles.ts";
import { calcPositionSize, calcWinRate, calcProfitFactor, calcMaxDrawdown } from "./risk.ts";
import { execute } from "../executor.ts";
import { create as createPortfolio, update as updatePortfolio } from "../portfolio.ts";
import type { Config } from "../config.ts";
import type { MarketSnapshot } from "../market.ts";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestReport {
  symbol: string;
  candleCount: number;
  closedTrades: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  profitFactor: number;
  maxDrawdownPercent: number;
}

/**
 * Replay `analyze()` + `execute()` (the same paper-fill fee logic the paper
 * trading path uses live — never reimplemented here) against `candles`,
 * producing the same win-rate/profit-factor/drawdown metrics
 * `learning/analyzer.ts` computes for live trades, via the same
 * `calcWinRate`/`calcProfitFactor`/`calcMaxDrawdown` (`strategy/risk.ts`).
 *
 * Deviates from the spec's originally-sketched synchronous signature:
 * `execute()` is `async` (matching the live Bybit path's interface even
 * though the paper branch itself awaits nothing), so reusing it rather than
 * duplicating its fee logic makes this function async too.
 *
 * Calls `clearHistory()` at the start — this replay owns the strategy
 * engine's per-symbol indicator/persistence state for its own duration, so
 * don't run this concurrently with a live session or another backtest in
 * the same process.
 */
export async function runBacktest(
  candles: Candle[],
  symbol: string,
  config: Config,
): Promise<BacktestReport> {
  clearHistory();
  clearCandles();

  let portfolio = createPortfolio(config.maxCapitalUsd);
  const pnls: number[] = [];
  const equityCurve: number[] = [portfolio.totalValueUsd];
  let totalFees = 0;
  let openEntry: { price: number; quantity: number; fee: number } | null = null;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const snapshot: MarketSnapshot = {
      symbol, price: candle.close, change24h: 0, volume24h: candle.volume,
      timestamp: candle.openTime, high24h: candle.high, low24h: candle.low,
    };

    // Feed the same candle store the live path feeds, so a model gate sees
    // an identical window here and in production. Bounded slice keeps this
    // O(window) per step rather than O(n^2) across a long replay; candles
    // up to and including `i` are complete at the moment we act on i's close.
    seedCandles(symbol, candles.slice(Math.max(0, i - 199), i + 1));

    // Mark the position to this candle's close before evaluating a new
    // signal, exactly like a live no-trade tick would (reuses
    // portfolio.update()'s "hold" branch) — so the equity curve below
    // reflects real mark-to-market, not just trade-tick snapshots.
    portfolio = updatePortfolio(portfolio, {
      symbol, side: "hold", quantity: 0, price: snapshot.price, fee: 0, timestamp: snapshot.timestamp,
    });

    const signal = analyze(snapshot, portfolio, config);
    const hasPosition = portfolio.positions.some(p => p.symbol === symbol);
    const actionable = (signal.type === "buy" || signal.type === "sell") && !(signal.type === "sell" && !hasPosition);

    if (actionable) {
      const positionUsd = signal.type === "buy"
        ? calcPositionSize(portfolio, config, signal.indicators.atr, snapshot.price)
        : 0;

      if (!(signal.type === "buy" && positionUsd <= 0)) {
        const result = await execute(signal, config, portfolio, snapshot, positionUsd);
        try {
          portfolio = updatePortfolio(portfolio, result);
          if (result.side === "buy" && result.quantity > 0) {
            openEntry = { price: result.price, quantity: result.quantity, fee: result.fee };
            totalFees += result.fee;
          } else if (result.side === "sell" && result.quantity > 0 && openEntry) {
            const pnl = (result.price - openEntry.price) * result.quantity - openEntry.fee - result.fee;
            pnls.push(pnl);
            totalFees += result.fee;
            openEntry = null;
          }
        } catch {
          // portfolio.update() refuses a corrupted (NaN/negative) result —
          // can't happen from execute()'s own paper path, but skip rather
          // than throw, matching main.ts's own defensive handling.
        }
      }
    }

    equityCurve.push(portfolio.totalValueUsd);
  }

  return {
    symbol,
    candleCount: candles.length,
    closedTrades: pnls.length,
    winRate: calcWinRate(pnls),
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    totalFees,
    profitFactor: calcProfitFactor(pnls),
    maxDrawdownPercent: calcMaxDrawdown(equityCurve),
  };
}
