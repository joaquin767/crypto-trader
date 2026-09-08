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
  /** Post-only entries that rested, and how many actually filled. A low
   *  fill rate is the signal that the maker discount is being paid for in
   *  missed trades — and those misses are adversely selected. */
  restingPlaced?: number;
  restingFilled?: number;
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
const signalPlaceholder = null as unknown as Awaited<ReturnType<typeof analyze>>;

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

  // ── Post-only fill model ────────────────────────────────────────────
  // Previously every post-only entry was assumed to fill at the decision
  // bar's close. That is false, and false in the direction that flatters
  // results: a resting bid only fills if price actually trades DOWN to it,
  // so you fill when the market comes back to you and miss when it runs
  // away — i.e. you systematically capture the losers and skip the winners.
  // Observed live on 2026-09-08: six consecutive post-only entries failed to
  // fill while APT rose, then one filled when price came back.
  //
  // Modelled here as a real resting order: it sits at the bid (the close
  // less a half-spread), and fills only if a later bar's LOW reaches it,
  // within postOnlyRestBars. Fill price is the resting price, which is the
  // whole point of paying maker.
  //
  // Known limitation, stated rather than hidden: OHLC cannot model queue
  // position. A real order at the touch may still not fill when price only
  // grazes the level, so even this is an upper bound — just a far tighter
  // one than "always fills".
  let resting: { price: number; barsLeft: number; positionUsd: number; signal: typeof signalPlaceholder } | null = null;
  let restingPlaced = 0, restingFilled = 0, restingCancelled = 0;

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

    // A resting post-only entry is resolved against THIS bar before any new
    // decision: did price trade down to our bid, or has it timed out?
    if (resting !== null) {
      if (candle.low <= resting.price) {
        const fillSnapshot: MarketSnapshot = { ...snapshot, price: resting.price };
        const result = await execute(resting.signal, config, portfolio, fillSnapshot, resting.positionUsd);
        if (result.side === "buy" && result.quantity > 0) {
          try {
            portfolio = updatePortfolio(portfolio, result);
            openEntry = { price: result.price, quantity: result.quantity, fee: result.fee };
            totalFees += result.fee;
            restingFilled += 1;
          } catch { /* corrupted result — skip, as elsewhere */ }
        }
        resting = null;
      } else if (--resting.barsLeft <= 0) {
        resting = null;
        restingCancelled += 1;
      }
    }

    const signal = analyze(snapshot, portfolio, config);
    const hasPosition = portfolio.positions.some(p => p.symbol === symbol);
    // Don't stack a new entry on top of one already resting.
    const actionable = (signal.type === "buy" || signal.type === "sell")
      && !(signal.type === "sell" && !hasPosition)
      && !(signal.type === "buy" && resting !== null);

    if (actionable) {
      const positionUsd = signal.type === "buy"
        ? calcPositionSize(portfolio, config, signal.indicators.atr, snapshot.price)
        : 0;

      // Post-only entries rest instead of executing immediately. Closes are
      // never post-only (see config.usePostOnlyEntries) so a sell falls
      // through to the immediate path below, as it does live.
      if (signal.type === "buy" && config.usePostOnlyEntries && positionUsd > 0) {
        const halfSpread = (config.postOnlyHalfSpreadPercent ?? 0.01) / 100;
        resting = {
          price: snapshot.price * (1 - halfSpread),
          barsLeft: config.postOnlyRestBars ?? 1,
          positionUsd,
          signal,
        };
        restingPlaced += 1;
        equityCurve.push(portfolio.totalValueUsd);
        continue;
      }

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
    restingPlaced,
    restingFilled,
    winRate: calcWinRate(pnls),
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    totalFees,
    profitFactor: calcProfitFactor(pnls),
    maxDrawdownPercent: calcMaxDrawdown(equityCurve),
  };
}
