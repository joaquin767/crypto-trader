import {
  calcRSI, calcMACD, calcSMA, calcBollinger, calcATR, calcMomentum,
  type MACDResult, type BollingerResult,
} from "./indicators.ts";
import type { MarketSnapshot } from "../market.ts";
import type { Config } from "../config.ts";
import type { Portfolio } from "../portfolio.ts";

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
}

// In-memory price history per symbol (for indicator calculation)
const _history = new Map<string, PriceHistory>();

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
 * Analyze a market snapshot against multiple technical indicators and return a
 * scored trade signal. This simulates an expert trader's decision process.
 */
export function analyze(
  snapshot: MarketSnapshot,
  portfolio: Portfolio,
  config: Config,
): TradeSignal {
  const history = getHistory(snapshot.symbol);

  // Record this snapshot in history
  history.prices.push(snapshot.price);
  history.highs.push(snapshot.price * (1 + Math.random() * 0.02)); // simulated high
  history.lows.push(snapshot.price * (1 - Math.random() * 0.02));  // simulated low
  history.timestamps.push(snapshot.timestamp);

  // Keep last 100 data points
  if (history.prices.length > 100) {
    history.prices = history.prices.slice(-100);
    history.highs = history.highs.slice(-100);
    history.lows = history.lows.slice(-100);
    history.timestamps = history.timestamps.slice(-100);
  }

  // Calculate all indicators
  const rsi = calcRSI(history.prices, 14);
  const macd = calcMACD(history.prices);
  const sma50 = calcSMA(history.prices, 20);
  const bollinger = calcBollinger(history.prices, 20, 2);
  const atr = calcATR(history.highs, history.lows, history.prices, 14);
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
    const lossPercent = ((existing.currentPrice - snapshot.price) / existing.currentPrice) * 100;
    const profitPercent = ((snapshot.price - existing.currentPrice) / existing.currentPrice) * 100;

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

    // Expert exit signal — RSI overbought + price above upper band
    if (rsi > 70 && snapshot.price > bollinger.upper) {
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

  // Final decision
  if (buyScore >= sellScore && buyScore >= 4) {
    type = "buy";
    confidence = Math.min(0.95, 0.4 + buyScore * 0.1);
  } else if (sellScore > buyScore && sellScore >= 4) {
    type = "sell";
    confidence = Math.min(0.95, 0.4 + sellScore * 0.1);
  } else {
    type = "hold";
    confidence = 0.3;
  }

  return {
    type,
    symbol: snapshot.symbol,
    confidence: Math.round(confidence * 100) / 100,
    reason: reasons.length > 0 ? reasons.join("; ") : "no clear signal",
    indicators: { rsi, macd, bollinger, momentum, atr },
  };
}