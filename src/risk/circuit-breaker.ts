// Portfolio-level circuit breakers — see specs/live-trading-readiness.md §5.
//
// docs/RISK_MANAGEMENT.md used to state outright: "The system does NOT have a
// hard 'stop-loss on total capital.' You are responsible for monitoring the
// dashboard and stopping if losses exceed your comfort level." For a system
// whose core promise is "you decide the cap, we never exceed it," having no
// automated response to a strategy actively losing money inside that cap was
// the single biggest gap between the documented promise and actual behavior.
//
// Every check here blocks only NEW position-opening trades. None of them ever
// block a close — a circuit breaker exists to stop the system from *adding*
// risk, never to stop it from *reducing* risk it already has. Pure functions
// throughout: state is passed in and a new state / trip result is returned,
// no hidden mutation, so this is trivially testable without mocking the rest
// of the app.

export interface CircuitBreakerConfig {
  /** % of maxCapitalUsd lost from the day's opening equity. `false` disables. */
  maxDailyLossPercent: number | false;
  /** % drawdown from peak equity this session. `false` disables. */
  maxDrawdownHaltPercent: number | false;
  /** Consecutive losing closed trades. `false` disables. */
  maxConsecutiveLosses: number | false;
  /** % a fill price may differ from the signal-time market price before it's
   *  treated as an anomaly. `false` disables. */
  maxSlippagePercent: number | false;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxDailyLossPercent: 10,
  maxDrawdownHaltPercent: 20,
  maxConsecutiveLosses: 5,
  maxSlippagePercent: 2,
};

export interface CircuitBreakerState {
  dayStartEquity: number;
  /** UTC calendar date ("YYYY-MM-DD") the current dayStartEquity belongs to. */
  dayStartUtcDate: string;
  peakEquity: number;
  consecutiveLosses: number;
}

export type CircuitBreakerTrigger = "dailyLoss" | "drawdown" | "consecutiveLosses" | "slippage";

export interface CircuitBreakerTrip {
  trigger: CircuitBreakerTrigger;
  at: number;
  details: string;
  /** Present only for "slippage" — that trip is scoped to one symbol, not the
   *  whole portfolio, unlike the other three triggers. */
  symbol?: string;
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function createCircuitBreakerState(initialEquity: number, now: number = Date.now()): CircuitBreakerState {
  return {
    dayStartEquity: initialEquity,
    dayStartUtcDate: utcDateString(now),
    peakEquity: initialEquity,
    consecutiveLosses: 0,
  };
}

/**
 * Update running equity tracking (UTC-day rollover for the daily-loss basis,
 * peak-equity high-water-mark for drawdown) and check the two equity-based
 * triggers. Call this once per trading cycle with current portfolio equity,
 * BEFORE evaluating whether to open any new position. Returns the updated
 * state (day/peak tracking always advances, even when nothing trips) and the
 * first trip found, if any.
 */
export function checkEquityBreakers(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  currentEquity: number,
  maxCapitalUsd: number,
  now: number = Date.now(),
): { state: CircuitBreakerState; trip: CircuitBreakerTrip | null } {
  const today = utcDateString(now);
  let next = state;
  if (today !== state.dayStartUtcDate) {
    next = { ...state, dayStartEquity: currentEquity, dayStartUtcDate: today };
  }
  if (currentEquity > next.peakEquity) {
    next = { ...next, peakEquity: currentEquity };
  }

  if (config.maxDailyLossPercent !== false) {
    const lossPercent = ((next.dayStartEquity - currentEquity) / maxCapitalUsd) * 100;
    if (lossPercent >= config.maxDailyLossPercent) {
      return {
        state: next,
        trip: {
          trigger: "dailyLoss", at: now,
          details: `Daily loss ${lossPercent.toFixed(1)}% of operating capital (limit ${config.maxDailyLossPercent}%) — halted for the rest of the UTC day.`,
        },
      };
    }
  }

  if (config.maxDrawdownHaltPercent !== false && next.peakEquity > 0) {
    const drawdownPercent = ((next.peakEquity - currentEquity) / next.peakEquity) * 100;
    if (drawdownPercent >= config.maxDrawdownHaltPercent) {
      return {
        state: next,
        trip: {
          trigger: "drawdown", at: now,
          details: `Drawdown ${drawdownPercent.toFixed(1)}% from session peak equity (limit ${config.maxDrawdownHaltPercent}%) — halted until resumed.`,
        },
      };
    }
  }

  return { state: next, trip: null };
}

/** Update the consecutive-loss counter after a trade closes. Call once per closed trade. */
export function recordTradeOutcome(state: CircuitBreakerState, pnl: number): CircuitBreakerState {
  return { ...state, consecutiveLosses: pnl < 0 ? state.consecutiveLosses + 1 : 0 };
}

/** Check the consecutive-losses trigger. Call after recordTradeOutcome. */
export function checkConsecutiveLosses(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number = Date.now(),
): CircuitBreakerTrip | null {
  if (config.maxConsecutiveLosses === false) return null;
  if (state.consecutiveLosses >= config.maxConsecutiveLosses) {
    return {
      trigger: "consecutiveLosses", at: now,
      details: `${state.consecutiveLosses} consecutive losing trades (limit ${config.maxConsecutiveLosses}) — halted until resumed.`,
    };
  }
  return null;
}

/**
 * Check a single fill's price against the market price at signal time. Scoped
 * to one symbol — a slippage anomaly on one symbol says nothing about the
 * others, so unlike the other three triggers this never halts the whole
 * portfolio.
 */
export function checkSlippage(
  config: CircuitBreakerConfig,
  symbol: string,
  signalPrice: number,
  fillPrice: number,
  now: number = Date.now(),
): CircuitBreakerTrip | null {
  if (config.maxSlippagePercent === false) return null;
  if (signalPrice <= 0 || fillPrice <= 0) return null;
  const slippagePercent = (Math.abs(fillPrice - signalPrice) / signalPrice) * 100;
  if (slippagePercent >= config.maxSlippagePercent) {
    return {
      trigger: "slippage", at: now, symbol,
      details: `${symbol} fill price $${fillPrice} is ${slippagePercent.toFixed(1)}% away from the signal-time market price $${signalPrice} (limit ${config.maxSlippagePercent}%) — entries halted for this symbol pending review.`,
    };
  }
  return null;
}
