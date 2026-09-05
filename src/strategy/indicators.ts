// Expert trading: technical indicators for market analysis.
// Each indicator is a pure function — no state, no side effects.

export interface MACDResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
  bullish: boolean;  // macdLine crossed above signalLine
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  width: number;     // (upper - lower) / middle, as % bandwidth
}

// ── Simple Moving Average ───────────────────────────────────────────────

export function calcSMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Exponential Moving Average ───────────────────────────────────────────

export function calcEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
  }
  return ema;
}

// ── Relative Strength Index ──────────────────────────────────────────────

export function calcRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50; // neutral default
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i]! - prices[i - 1]!);
  }
  const recent = changes.slice(-period);
  const avgGain = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const avgLoss = recent.filter(c => c < 0).reduce((a, b) => a - b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ── MACD ─────────────────────────────────────────────────────────────────

export function calcMACD(prices: number[]): MACDResult {
  const macdLine = calcEMA(prices, 12) - calcEMA(prices, 26);
  // signal line = 9-period EMA of macdLine — approximate with SMA of last 9
  const histLen = Math.min(9, prices.length);
  const macdHistory: number[] = [];
  for (let i = prices.length - histLen; i < prices.length; i++) {
    const slice = prices.slice(Math.max(0, i - 25), i + 1);
    macdHistory.push(calcEMA(slice, 12) - calcEMA(slice, 26));
  }
  const signalLine = macdHistory.reduce((a, b) => a + b, 0) / macdHistory.length;
  const histogram = macdLine - signalLine;
  const prevMacd = macdHistory.length > 1 ? macdHistory[macdHistory.length - 2]! : macdLine;
  return { macdLine, signalLine, histogram, bullish: prevMacd < signalLine && macdLine >= signalLine };
}

// ── Bollinger Bands ──────────────────────────────────────────────────────

export function calcBollinger(prices: number[], period = 20, multiplier = 2): BollingerResult {
  const middle = calcSMA(prices, period);
  const slice = prices.slice(-period);
  const variance = slice.reduce((sum, p) => sum + (p - middle) ** 2, 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  return {
    middle,
    upper: middle + multiplier * stdDev,
    lower: middle - multiplier * stdDev,
    width: (2 * multiplier * stdDev) / middle,
  };
}

// ── Average True Range (volatility) ──────────────────────────────────────

export function calcATR(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (closes.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < Math.min(closes.length, period + 1); i++) {
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!),
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / Math.max(trs.length, 1);
}

// ── Price change momentum ────────────────────────────────────────────────

export function calcMomentum(prices: number[], period = 10): number {
  if (prices.length < period + 1) return 0;
  const current = prices[prices.length - 1]!;
  const past = prices[prices.length - 1 - period]!;
  return ((current - past) / past) * 100;
}