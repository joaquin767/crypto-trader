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

// ── Stateful, smoothed RSI (spec: specs/strategy-signal-quality.md §3) ───
//
// calcRSI() above recomputes avgGain/avgLoss from scratch over the trailing
// `period` raw price deltas on every call, with no memory of the previous
// average — a single new tick fully replaces 1/period of the window's
// composition, which on real market noise swings the result across its
// entire 0-100 range within one or two ticks (see F1's live evidence). This
// carries a running, exponentially-smoothed average between calls instead —
// real Wilder RSI — while still bootstrapping its very first value from the
// classic one-shot average (identical arithmetic to calcRSI) so a freshly
// seeded/cold-started history reflects its whole trend immediately, exactly
// like calcRSI does today; only calls *after* that first one are smoothed.

export interface RsiState {
  avgGain: number;
  avgLoss: number;
  initialized: boolean;
}

export const initialRsiState = (): RsiState => ({ avgGain: 0, avgLoss: 0, initialized: false });

function rsiValue(state: RsiState): number {
  return state.avgLoss === 0 ? 100 : 100 - 100 / (1 + state.avgGain / state.avgLoss);
}

/**
 * Update RSI from the full price history. Bootstraps once (same formula as
 * `calcRSI`) when `state` isn't initialized yet; every subsequent call folds
 * in only the latest price delta via Wilder's smoothed running average.
 */
export function updateRsi(state: RsiState, prices: number[], period = 14): { state: RsiState; value: number } {
  if (!state.initialized) {
    if (prices.length < period + 1) return { state, value: 50 };
    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) changes.push(prices[i]! - prices[i - 1]!);
    const recent = changes.slice(-period);
    const avgGain = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
    const avgLoss = recent.filter(c => c < 0).reduce((a, b) => a - b, 0) / period;
    const newState: RsiState = { avgGain, avgLoss, initialized: true };
    return { state: newState, value: rsiValue(newState) };
  }

  if (prices.length < 2) return { state, value: rsiValue(state) };
  const priceChange = prices[prices.length - 1]! - prices[prices.length - 2]!;
  const gain = Math.max(priceChange, 0);
  const loss = Math.max(-priceChange, 0);
  const newState: RsiState = {
    avgGain: (state.avgGain * (period - 1) + gain) / period,
    avgLoss: (state.avgLoss * (period - 1) + loss) / period,
    initialized: true,
  };
  return { state: newState, value: rsiValue(newState) };
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

// ── Stateful, smoothed MACD (spec: specs/strategy-signal-quality.md §3) ──
//
// calcMACD() above reconstructs several historical MACD values by re-running
// calcEMA() from scratch over shifting trailing slices every call, then
// averages them arithmetically to approximate a signal line — a real signal
// line is itself an EMA (exponentially weighted, with memory), not a flat
// average recomputed each time (F6). This carries emaFast/emaSlow/signal as
// running state, bootstrapping emaFast/emaSlow from the classic `calcEMA`
// over the full window on the first call (so a freshly seeded/cold-started
// history reflects its whole trend immediately), then folding incrementally.

export interface MacdState {
  emaFast: number | null;
  emaSlow: number | null;
  signal: number | null;
}

export const initialMacdState = (): MacdState => ({ emaFast: null, emaSlow: null, signal: null });

export function updateMacd(
  state: MacdState, prices: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9,
): { state: MacdState; result: MACDResult } {
  if (prices.length === 0) {
    return { state, result: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false } };
  }
  const price = prices[prices.length - 1]!;
  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);
  const kSig = 2 / (signalPeriod + 1);

  const emaFast = state.emaFast === null ? calcEMA(prices, fastPeriod) : price * kFast + state.emaFast * (1 - kFast);
  const emaSlow = state.emaSlow === null ? calcEMA(prices, slowPeriod) : price * kSlow + state.emaSlow * (1 - kSlow);
  const macdLine = emaFast - emaSlow;
  // prevMacd: the MACD line implied by the *previous* state, for crossover
  // detection. On the bootstrap call there is no previous state, so it's
  // defined equal to this call's own macdLine — that makes `bullish` false
  // on the bootstrap call (nothing to compare against yet), exactly as
  // "cannot fire on the very first tick after initialization" requires.
  const prevMacd = state.emaFast === null ? macdLine : state.emaFast - state.emaSlow!;
  const signal = state.signal === null ? macdLine : macdLine * kSig + state.signal * (1 - kSig);
  const histogram = macdLine - signal;
  const bullish = state.signal !== null && prevMacd < state.signal && macdLine >= signal;

  return { state: { emaFast, emaSlow, signal }, result: { macdLine, signalLine: signal, histogram, bullish } };
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