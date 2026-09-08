import {
  calcSMA, calcBollinger, calcATR, calcMomentum,
  updateRsi, updateMacd, initialRsiState, initialMacdState,
  type MACDResult, type BollingerResult, type RsiState, type MacdState,
} from "./indicators.ts";
import { hasPlausibleEdge } from "./risk.ts";
import { loadModel, scoreCandles, scoreQuantile, resetThresholdCache, type ModelWeights } from "./model.ts";
export { resetThresholdCache };
import { getCandles } from "./candles.ts";
import type { MarketSnapshot } from "../market.ts";
import type { Config } from "../config.ts";
import type { Portfolio } from "../portfolio.ts";
import type { Candle } from "./backtest.ts";

export type SignalType = "buy" | "sell" | "hold";

export interface TradeSignal {
  type: SignalType;
  symbol: string;
  confidence: number;   // 0-1
  reason: string;
  indicators: {
    rsi: number;
    macd: MACDResult;
    bollinger: BollingerResult;
    momentum: number;
    atr: number;
  };
}

export interface PriceHistory {
  prices: number[];
  highs: number[];
  lows: number[];
  timestamps: number[];
  /** Running smoothed-indicator state (specs/strategy-signal-quality.md §3).
   *  Optional so existing seeded-history call sites (tests, mainly) don't
   *  need to know about it — missing state is simply treated as fresh/
   *  uninitialized, which bootstraps from the seeded window on first use. */
  rsiState?: RsiState;
  macdState?: MacdState;
  /** Signal-persistence tracking for new entries (§4, resolves F2) — the
   *  last "raw" (pre-confirmation) direction this symbol scored, and how
   *  many consecutive calls it's persisted for. */
  lastRawDirection?: SignalType;
  rawDirectionStreak?: number;
}

// In-memory price history per symbol (for indicator calculation)
const _history = new Map<string, PriceHistory>();

// Lazily-loaded entry model. Cached because loadModel() reads and validates
// a file — doing that per tick would be wasteful, and re-reading mid-session
// would let the strategy silently change behavior underneath a running
// position. `attempted` makes a missing model warn exactly once.
let _model: ModelWeights | null = null;
let _modelLoadAttempted = false;

function getModel(): ModelWeights | null {
  if (!_modelLoadAttempted) {
    _modelLoadAttempted = true;
    _model = loadModel();
    if (_model === null) {
      console.warn("[model] useModelGate is on but no usable weights file was loaded — entries will NOT be model-gated. Train one with scripts/train-model.ts.");
    } else {
      const m = _model.metrics;
      console.log(`[model] Loaded entry model (test AUC ${m.testAuc.toFixed(3)}, ${m.testSamples} held-out samples, trained on ${_model.trainedOn.symbols.join("/")} ${_model.trainedOn.interval}m, TP ${_model.trainedOn.takeProfitPercent}% / SL ${_model.trainedOn.stopLossPercent}% / ${_model.trainedOn.horizonBars} bars).`);
    }
  }
  return _model;
}

/**
 * Inject a specific model, bypassing the lazy disk load.
 *
 * Exists for the walk-forward harness (specs/profit-target-roadmap.md G0.3):
 * each fold must be scored by the model fit on THAT fold's training window,
 * never by whatever happens to be on disk. Passing null forces "no model".
 *
 * Clears the percentile-threshold cache too, since those thresholds are
 * derived from the model's own score distribution and are meaningless across
 * a model swap.
 */
export function setModel(model: ModelWeights | null): void {
  _model = model;
  _modelLoadAttempted = true;
  _percentileThresholds.clear();
}

/** Reset the cached model (tests only). */
export function resetModelCache(): void {
  _model = null;
  _modelLoadAttempted = false;
  _percentileThresholds.clear();
}

// Per-symbol entry threshold derived from the model's OWN score
// distribution, computed once per symbol per session. Cached because
// scoreQuantile() scores ~200 historical windows, which is far too
// expensive to redo on every bar.
const _percentileThresholds = new Map<string, number>();

/**
 * The score a candidate must beat for this symbol. Percentile mode when
 * config.modelTopPercentile is set (preferred — absolute probabilities do
 * not transfer across symbols or regimes), otherwise the fixed
 * modelMinProbability.
 */
function entryThresholdFor(
  model: ModelWeights, symbol: string, candles: Candle[], config: Config,
): number | null {
  const pct = config.modelTopPercentile;
  if (pct === undefined) return config.modelMinProbability ?? 0.5;

  const cached = _percentileThresholds.get(symbol);
  if (cached !== undefined) return cached;

  const q = scoreQuantile(model, candles, symbol, pct);
  if (q === null) return null;  // not enough history yet — no opinion
  _percentileThresholds.set(symbol, q);
  console.log(`[model] ${symbol}: entering on the top ${pct}% of scores => threshold ${q.toFixed(4)} (calibrated from this symbol's own recent distribution).`);
  return q;
}

/**
 * How long the loaded model's forecast is actually valid for, in ms —
 * `horizonBars` x the bar interval it was trained on. Returns null when the
 * model isn't driving entries or no weights are loaded, in which case the
 * caller keeps its pre-model behaviour rather than inventing a horizon.
 */
function modelHorizonMsFor(config: Config): number | null {
  if (!config.useModelGate) return null;
  const model = getModel();
  if (model === null) return null;
  const bars = model.trainedOn.horizonBars;
  if (!Number.isFinite(bars) || bars <= 0) return null;
  // Dollar bars have no fixed interval, so the trainer records the median
  // observed bar duration. Fall back to the nominal interval for a
  // time-bar model.
  const barMs = model.trainedOn.avgBarMs
    ?? Number.parseFloat(model.trainedOn.interval) * 60_000;
  if (!Number.isFinite(barMs) || barMs <= 0) return null;
  return bars * barMs;
}

/** Get or initialize price history for a symbol. */
export function getHistory(symbol: string): PriceHistory {
  let h = _history.get(symbol);
  if (!h) {
    h = { prices: [], highs: [], lows: [], timestamps: [] };
    _history.set(symbol, h);
  }
  return h;
}

/** Seed initial history for testing. */
export function setHistory(symbol: string, h: PriceHistory): void {
  _history.set(symbol, h);
}

/** Clear all history (for tests). */
export function clearHistory(): void {
  _history.clear();
}

/**
 * Risk-reducing exits that must be checked on EVERY tick, never deferred to
 * a candle close: stop-loss, take-profit, and model-horizon expiry.
 *
 * These deliberately need no indicators — only the position's cost basis,
 * the current price, and the clock — which is exactly why they can run at
 * tick cadence while everything indicator-driven runs once per bar. Moving
 * decisions onto candle closes (so live matches runBacktest) must never
 * mean a stop-loss waits up to five minutes to fire; that would trade one
 * class of bug for a far more dangerous one.
 *
 * Returns null when no exit is warranted.
 */
export function checkImmediateExit(
  position: { symbol: string; entryPrice: number; openedAt?: number },
  snapshot: MarketSnapshot,
  config: Config,
): { type: "sell"; symbol: string; confidence: number; reason: string } | null {
  const lossPercent = ((position.entryPrice - snapshot.price) / position.entryPrice) * 100;
  const profitPercent = ((snapshot.price - position.entryPrice) / position.entryPrice) * 100;

  if (lossPercent >= config.stopLossPercent) {
    return { type: "sell", symbol: position.symbol,
      confidence: Math.min(0.9, 0.7 + lossPercent / 50),
      reason: `stop-loss: ${lossPercent.toFixed(1)}% drop` };
  }
  if (profitPercent >= config.takeProfitPercent) {
    return { type: "sell", symbol: position.symbol,
      confidence: Math.min(0.9, 0.7 + profitPercent / 50),
      reason: `take-profit: ${profitPercent.toFixed(1)}% gain` };
  }

  const horizonMs = modelHorizonMsFor(config);
  if (horizonMs !== null && position.openedAt !== undefined) {
    const ageMs = snapshot.timestamp - position.openedAt;
    if (ageMs >= horizonMs) {
      return { type: "sell", symbol: position.symbol, confidence: 0.6,
        reason: `model horizon elapsed (${Math.round(ageMs / 60000)}m) without hitting either barrier` };
    }
  }
  return null;
}

/**
 * Analyze a market snapshot against multiple technical indicators and return a
 * scored trade signal. This simulates an expert trader's decision process.
 */
export function analyze(
  snapshot: MarketSnapshot,
  portfolio: Portfolio,
  config: Config,
): TradeSignal {
  const history = getHistory(snapshot.symbol);

  // Record this snapshot in history. Prefer the exchange's real 24h high/low
  // (populated on live Bybit tickers) over fabricated noise — ATR and the
  // volatility gate below previously reasoned over Math.random() output even
  // when connected to a real market, which is noise dressed up as data.
  // Paper/simulated snapshots don't carry high24h/low24h, so they still fall
  // back to the simulated spread.
  history.prices.push(snapshot.price);
  history.highs.push(snapshot.high24h ?? snapshot.price * (1 + Math.random() * 0.02));
  history.lows.push(snapshot.low24h ?? snapshot.price * (1 - Math.random() * 0.02));
  history.timestamps.push(snapshot.timestamp);

  // Keep last 100 data points
  if (history.prices.length > 100) {
    history.prices = history.prices.slice(-100);
    history.highs = history.highs.slice(-100);
    history.lows = history.lows.slice(-100);
    history.timestamps = history.timestamps.slice(-100);
  }

  // Calculate all indicators. RSI/MACD use running, smoothed state (see
  // indicators.ts's updateRsi/updateMacd doc comments and
  // specs/strategy-signal-quality.md §3) instead of recomputing from a raw
  // trailing window every call — that recompute-from-scratch pattern is what
  // made RSI swing across its full 0-100 range within one or two ticks (F1).
  const rsiUpdate = updateRsi(history.rsiState ?? initialRsiState(), history.prices, 14);
  history.rsiState = rsiUpdate.state;
  const rsi = rsiUpdate.value;

  const macdUpdate = updateMacd(history.macdState ?? initialMacdState(), history.prices, 12, 26, 9);
  history.macdState = macdUpdate.state;
  const macd = macdUpdate.result;

  const sma50 = calcSMA(history.prices, 20);
  const bollinger = calcBollinger(history.prices, 20, 2);

  // ATR from the 5m candle series when it's available, falling back to the
  // tick history only before the candle window has filled.
  //
  // history.highs/lows are populated from snapshot.high24h/low24h — the
  // exchange ticker's rolling 24-HOUR high and low. Feeding those to
  // calcATR produced an "ATR" that was really the daily range: 8.76% on
  // APT/USDT live, versus ~0.3% computed over actual 5m bars. Two things
  // silently rode on that:
  //   - the volatility penalty below (atrPercent > 5% adds to sellScore)
  //     fired on literally every evaluation, a permanent bias against
  //     entering;
  //   - calcPositionSize() sized off max(stopLoss, atr x multiplier), so
  //     positions came out ~4x smaller than the configured cap.
  // It also meant live and runBacktest() were running measurably different
  // strategies, since the backtest feeds real per-bar highs/lows — so
  // backtested expectancy did not describe live behaviour at all.
  const candles = getCandles(snapshot.symbol);
  const atr = candles.length >= 15
    ? calcATR(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close), 14)
    : calcATR(history.highs, history.lows, history.prices, 14);
  const momentum = calcMomentum(history.prices, 10);
  const volumeSurge = snapshot.volume24h > 500; // simulated volume check

  // ── Decision logic (expert consensus) ─────────────────────────────

  const existing = portfolio.positions.find(p => p.symbol === snapshot.symbol);
  let type: SignalType = "hold";
  let confidence = 0.3;
  const reasons: string[] = [];

  // Check daily trade limit
  if (config.maxDailyTrades > 0 && portfolio.dailyTradeCount >= config.maxDailyTrades) {
    return {
      type: "hold", symbol: snapshot.symbol, confidence: 1, reason: "maxDailyTrades reached", indicators: {
        rsi, macd, bollinger, momentum, atr,
      },
    };
  }

  // ── Existing position management ────────────────────────────────────
  if (existing) {
    // Measured against entryPrice — the position's actual cost basis — NOT
    // currentPrice. This previously used currentPrice, which silently
    // disabled stop-loss and take-profit for any position whose
    // currentPrice had been refreshed to the live mark price: both
    // percentages then compute against the price they're being compared to,
    // i.e. ~0, so a position 15% underwater reported "holding: 0.0% below
    // entry" and never stopped out. That refresh is not hypothetical — it's
    // exactly what reconcilePositions() does (connector.ts, merging
    // `currentPrice` from adapters.ts's `markPrice`) on every position
    // update pushed by Bybit's private WS stream. The reason strings below
    // always claimed "below/above entry"; now the arithmetic actually
    // matches that claim.
    const lossPercent = ((existing.entryPrice - snapshot.price) / existing.entryPrice) * 100;
    const profitPercent = ((snapshot.price - existing.entryPrice) / existing.entryPrice) * 100;

    // Stop-loss
    if (lossPercent >= config.stopLossPercent) {
      return {
        type: "sell", symbol: snapshot.symbol,
        confidence: Math.min(0.9, 0.7 + lossPercent / 50),
        reason: `stop-loss: ${lossPercent.toFixed(1)}% drop`,
        indicators: { rsi, macd, bollinger, momentum, atr },
      };
    }

    // Take-profit
    if (profitPercent >= config.takeProfitPercent) {
      return {
        type: "sell", symbol: snapshot.symbol,
        confidence: Math.min(0.9, 0.7 + profitPercent / 50),
        reason: `take-profit: ${profitPercent.toFixed(1)}% gain`,
        indicators: { rsi, macd, bollinger, momentum, atr },
      };
    }

    // Expert exit signal — RSI overbought + price above upper band. Gated by
    // a minimum hold time (specs/strategy-signal-quality.md §4, resolves
    // F2): this rule reads the same noisy single-tick RSI/Bollinger signal
    // F1 describes, so without a floor it can close a position seconds
    // after opening it on pure noise (observed live: sub-minute round-trips
    // that lost almost exactly the round-trip fee). Stop-loss/take-profit
    // above are NEVER subject to this — a real loss or gain is always acted
    // on immediately, per design principle 3. A position with no known
    // open time (e.g. reconciled from the exchange) is treated as old
    // enough — this gate exists to damp noise on freshly-opened positions,
    // not to block managing a position whose age genuinely isn't known.
    // The model forecasts a specific question: "does price reach +TP% before
    // -SL% within `horizonBars`?" Observed live on 2026-09-08, five
    // consecutive trades entered on that forecast were closed by the
    // expert-exit rule after a MEDIAN OF 236s against a 7200s horizon — 3%
    // of the window the prediction was even made over. None of them was
    // ever given the chance to be right. So when the model is driving
    // entries, the position's clock is the model's clock:
    //   - the expert exit is held off until the horizon has elapsed (by
    //     which point the horizon exit below has already closed it, so the
    //     rule is effectively deferred rather than fighting the thesis);
    //   - stop-loss and take-profit are untouched above and still fire
    //     immediately, because those ARE the model's two barriers.
    const modelHorizonMs = modelHorizonMsFor(config);
    const minHoldMs = config.minHoldBeforeExpertExitMs ?? modelHorizonMs ?? 30000;
    const positionAgeMs = snapshot.timestamp - (existing.openedAt ?? 0);

    // Third barrier: horizon expiry. The training labels treat "horizon
    // elapsed without reaching TP" as an outcome in its own right (a 0, not
    // a skip), so a position that has neither hit TP nor SL by the end of
    // the forecast window is exactly the case the model priced — and
    // holding it past that point is trading on a prediction that has
    // already expired. Without this the horizon was only half-implemented:
    // entries used it, exits ignored it.
    if (modelHorizonMs !== null && existing.openedAt !== undefined && positionAgeMs >= modelHorizonMs) {
      return {
        type: "sell", symbol: snapshot.symbol,
        confidence: 0.6,
        reason: `model horizon elapsed (${Math.round(positionAgeMs / 60000)}m) without hitting either barrier`,
        indicators: { rsi, macd, bollinger, momentum, atr },
      };
    }

    if (rsi > 70 && snapshot.price > bollinger.upper && positionAgeMs >= minHoldMs) {
      return {
        type: "sell", symbol: snapshot.symbol,
        confidence: 0.75,
        reason: `expert exit: RSI ${rsi.toFixed(1)} (overbought), price above upper band`,
        indicators: { rsi, macd, bollinger, momentum, atr },
      };
    }

    return {
      type: "hold", symbol: snapshot.symbol, confidence: 0.5,
      reason: `holding: ${lossPercent >= 0 ? `${lossPercent.toFixed(1)}% below entry` : `${(-profitPercent).toFixed(1)}% above entry`}`,
      indicators: { rsi, macd, bollinger, momentum, atr },
    };
  }

  // ── New position evaluation ─────────────────────────────────────────
  let buyScore = 0;
  let sellScore = 0;

  // RSI analysis
  if (rsi < 30) { buyScore += 3; reasons.push(`RSI oversold (${rsi.toFixed(1)})`); }
  else if (rsi > 50 && rsi < 60) { buyScore += 1; reasons.push(`RSI neutral-bullish (${rsi.toFixed(1)})`); }
  else if (rsi > 70) { sellScore += 3; reasons.push(`RSI overbought (${rsi.toFixed(1)})`); }

  // MACD analysis
  if (macd.bullish) { buyScore += 3; reasons.push("MACD bullish crossover"); }
  else if (macd.histogram < -1) { sellScore += 2; reasons.push("MACD bearish divergence"); }

  // Bollinger Bands
  if (snapshot.price < bollinger.lower) { buyScore += 2; reasons.push("price below lower Bollinger Band"); }
  else if (snapshot.price > bollinger.upper) { sellScore += 2; reasons.push("price above upper Bollinger Band"); }

  // Momentum
  if (momentum > 2 && momentum < 15) { buyScore += 2; reasons.push(`positive momentum (${momentum.toFixed(1)}%)`); }
  else if (momentum < -5) { sellScore += 2; reasons.push(`negative momentum (${momentum.toFixed(1)}%)`); }

  // Volume surge
  if (volumeSurge) {
    if (momentum > 0) { buyScore += 1; reasons.push("volume surge + upward momentum"); }
    else { sellScore += 1; reasons.push("volume surge + downward momentum"); }
  }

  // Price vs SMA (trend filter)
  if (snapshot.price > sma50) { buyScore += 1; reasons.push("price above SMA(20)"); }
  else { sellScore += 1; reasons.push("price below SMA(20)"); }

  // Volatility check (avoid trading in extremely volatile conditions)
  const atrPercent = atr / snapshot.price;
  if (atrPercent > 0.05) {
    sellScore += 1;
    reasons.push(`high volatility (ATR ${(atrPercent * 100).toFixed(1)}%)`);
  }

  // Check max position size
  const positionValue = config.maxPositionSizeUsd;
  if (buyScore > 0 && positionValue > portfolio.cashUsd) {
    return {
      type: "hold", symbol: snapshot.symbol, confidence: 0.2,
      reason: "insufficient cash for position",
      indicators: { rsi, macd, bollinger, momentum, atr },
    };
  }

  // Cost-aware entry gate (specs/strategy-signal-quality.md §5, resolves
  // F4): a setup that would otherwise cross the entry threshold is refused
  // if the ATR-implied plausible move can't plausibly clear round-trip
  // cost — F3 showed this is exactly how 21/21 closed trades in a live
  // session lost money, almost all of them by nearly the fee alone. Checked
  // before the signal-confirmation gate below on purpose: there's no reason
  // to accumulate a confirmation streak for a setup that can never be
  // cost-effective at the current volatility, and if volatility later rises
  // enough to pass, confirmation correctly restarts from that point.
  if ((buyScore >= 4 || sellScore >= 4) && !hasPlausibleEdge(atr, snapshot.price, config)) {
    return {
      type: "hold", symbol: snapshot.symbol, confidence: 0.2,
      reason: "insufficient plausible edge vs. round-trip cost",
      indicators: { rsi, macd, bollinger, momentum, atr },
    };
  }

  // Learned-model entry gate (src/strategy/model.ts). Opt-in via
  // config.useModelGate. Only ever BLOCKS an entry the rule-based logic
  // already wanted — it never invents one — so the model can subtract bad
  // trades but can't add trades the strategy didn't independently justify.
  // A null score (not enough candle history yet, or no weights file) means
  // "no opinion" and falls through to the existing logic rather than
  // blocking, so a cold start doesn't silently freeze all trading.
  if (config.useModelGate && (buyScore >= 4 || sellScore >= 4)) {
    const model = getModel();
    if (model !== null) {
      const symbolCandles = getCandles(snapshot.symbol);
      const probability = scoreCandles(model, symbolCandles, snapshot.symbol);
      const threshold = entryThresholdFor(model, snapshot.symbol, symbolCandles, config);
      if (probability !== null && threshold !== null && probability < threshold) {
        return {
          type: "hold", symbol: snapshot.symbol, confidence: 0.2,
          reason: `model gate: p=${probability.toFixed(3)} below ${threshold.toFixed(3)}`,
          indicators: { rsi, macd, bollinger, momentum, atr },
        };
      }
    }
  }

  // Final decision (raw — before the signal-confirmation gate below)
  let rawType: SignalType = "hold";
  let rawConfidence = 0.3;
  if (buyScore >= sellScore && buyScore >= 4) {
    rawType = "buy";
    rawConfidence = Math.min(0.95, 0.4 + buyScore * 0.1);
  } else if (sellScore > buyScore && sellScore >= 4) {
    rawType = "sell";
    rawConfidence = Math.min(0.95, 0.4 + sellScore * 0.1);
  }

  // Signal-confirmation gate (specs/strategy-signal-quality.md §4, resolves
  // F2): a NEW-ENTRY signal must recur for signalConfirmationTicks
  // consecutive analyze() calls on this symbol before it's acted on —
  // single-tick agreement between noisy indicators is not a trend (F1).
  // This never applies to closing a position — that's handled entirely
  // above, before "new position evaluation" is ever reached.
  const confirmationTicks = Math.max(1, config.signalConfirmationTicks ?? 2);
  const streak = rawType !== "hold" && rawType === history.lastRawDirection
    ? (history.rawDirectionStreak ?? 0) + 1
    : (rawType !== "hold" ? 1 : 0);
  history.lastRawDirection = rawType;
  history.rawDirectionStreak = streak;

  const confirmed = rawType !== "hold" && streak >= confirmationTicks;
  type = confirmed ? rawType : "hold";
  confidence = confirmed ? rawConfidence : 0.3;
  const reason = rawType === "hold" || confirmed
    ? (reasons.length > 0 ? reasons.join("; ") : "no clear signal")
    : `${reasons.join("; ")} (awaiting confirmation: ${streak}/${confirmationTicks} ticks for ${rawType})`;

  return {
    type,
    symbol: snapshot.symbol,
    confidence: Math.round(confidence * 100) / 100,
    reason,
    indicators: { rsi, macd, bollinger, momentum, atr },
  };
}