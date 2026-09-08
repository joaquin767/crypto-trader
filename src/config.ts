import { readFileSync } from "node:fs";

export interface Config {
  exchange: string;            // e.g. "binance", "coinbase"
  apiKey: string;
  apiSecret: string;
  symbols: string[];           // e.g. ["BTC/USDT", "ETH/USDT"]
  maxCapitalUsd: number;       // 🔒 USER-DEFINED operating capital. The system NEVER exceeds this.
  maxPositionSizeUsd: number;  // max USD per trade (must be <= maxCapitalUsd)
  maxDailyTrades: number;      // max trades per day (0 = unlimited)
  stopLossPercent: number;     // e.g. 5 = sell if price drops 5% below entry
  takeProfitPercent: number;   // e.g. 10 = sell if price rises 10% above entry
  refreshIntervalMs: number;   // how often to poll market data (min 1000)
  autoSelectSymbols?: boolean; // if true, automatically pick best symbols for your capital at startup
  /** How close (as % of mark price) a position may get to its liquidation
   *  price before entries are halted and it's flagged for the user — see
   *  specs/live-trading-readiness.md §3.2. Default 15 if unset. */
  liquidationBufferPercent?: number;

  // ── Circuit breakers (spec §5) — each halts NEW entries only, never closes.
  // `false` explicitly disables that trigger; omitted uses the default in
  // src/risk/circuit-breaker.ts's DEFAULT_CIRCUIT_BREAKER_CONFIG.
  /** % of maxCapitalUsd lost from the day's opening equity. Default 10. */
  maxDailyLossPercent?: number | false;
  /** % drawdown from this session's peak equity. Default 20. */
  maxDrawdownHaltPercent?: number | false;
  /** Consecutive losing closed trades. Default 5. */
  maxConsecutiveLosses?: number | false;
  /** % a fill price may differ from the signal-time market price. Default 2. */
  maxSlippagePercent?: number | false;

  /** Starting `--live` with maxCapitalUsd above this prints a loud warning —
   *  see spec §7.2. Not a hard limit; a nudge encoding "start small" into the
   *  code. Default 500 if unset; `false` disables the check entirely. */
  maxCapitalUsdWarnThreshold?: number | false;

  // ── Risk-aware position sizing (spec §9) ──────────────────────────────
  /** % of maxCapitalUsd risked per trade (not the position's notional — the
   *  amount actually at stake if the stop-loss/ATR-derived stop is hit).
   *  Default 1, matching docs/RISK_MANAGEMENT.md's "never risk more than
   *  1-2% per trade" guidance. */
  riskPerTradePercent?: number;
  /** Multiplier on ATR-as-%-of-price when it implies a wider stop than
   *  config.stopLossPercent — the wider of the two is used as the sizing
   *  basis, so a volatile symbol gets a smaller position for the same risk
   *  budget instead of the same notional as a stable one. Default 2. */
  atrStopMultiplier?: number;
  /** % of cash held back as an unallocated buffer when sizing a new position
   *  (fees, slippage headroom). Default 10. */
  cashReservePercent?: number;

  // ── Concentration limits (spec §10) ───────────────────────────────────
  /** Max number of concurrently open positions. `false` disables the cap
   *  (only maxPositionSizeUsd × count vs. maxCapitalUsd still applies
   *  implicitly). Default undefined (uncapped) if unset. */
  maxConcurrentPositions?: number | false;
  /** Trailing price-return correlation above which a new position is skipped
   *  if it would sit alongside an existing one this correlated. Default 0.8;
   *  `false` disables the check. */
  maxCorrelation?: number | false;

  // ── Strategy signal-quality (specs/strategy-signal-quality.md §4) ─────
  /** Consecutive analyze() cycles a NEW-ENTRY signal must agree before it is
   *  acted on — damps single-tick indicator noise from becoming a real
   *  trade. Never applies to stop-loss/take-profit. Default 2. */
  signalConfirmationTicks?: number;
  /** Minimum ms a position must be held before the noise-prone "expert exit"
   *  rule (RSI/Bollinger-based) may close it. Stop-loss and take-profit are
   *  NEVER subject to this. Default 30000 (30s). */
  minHoldBeforeExpertExitMs?: number;
  /** Estimated round-trip (entry + exit) taker-fee cost, as a percent of
   *  notional, used only to gate entries whose plausible move can't
   *  plausibly clear costs (specs/strategy-signal-quality.md §5).
   *
   *  Default 0.11 — measured, not guessed: real fills in
   *  tests/fixtures/apt-usdt-session-2026-09-07.json show 0.055% per side
   *  (Bybit's standard non-VIP linear-perpetual TAKER rate), and a closed
   *  trade's journal `fee` field is entry+exit summed (journal.ts:172), so
   *  0.055 x 2 = 0.11 round trip. If order placement ever moves from
   *  market/taker to post-only/maker orders (0.02% per side on the same
   *  tier), this should drop to ~0.04.
   *
   *  Not used for actual fee accounting — real fees always come from the
   *  exchange fill / the paper executor's own rate. */
  estimatedRoundTripFeePercent?: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Load and validate a Config from a JSON file path.
 * Throws ConfigError on missing file, invalid JSON, or invalid values.
 */
export function loadConfig(path: string): Config {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    if (err instanceof SyntaxError) throw new ConfigError(`Invalid JSON in config: ${err.message}`);
    throw new ConfigError(`Cannot read config file at "${path}": ${(err as Error).message}`);
  }

  const config: Partial<Config> = {
    exchange: raw["exchange"] as string | undefined,
    apiKey: raw["apiKey"] as string | undefined,
    apiSecret: raw["apiSecret"] as string | undefined,
    symbols: raw["symbols"] as string[] | undefined,
    maxCapitalUsd: raw["maxCapitalUsd"] as number | undefined,
    maxPositionSizeUsd: raw["maxPositionSizeUsd"] as number | undefined,
    maxDailyTrades: raw["maxDailyTrades"] as number | undefined,
    stopLossPercent: raw["stopLossPercent"] as number | undefined,
    takeProfitPercent: raw["takeProfitPercent"] as number | undefined,
    refreshIntervalMs: raw["refreshIntervalMs"] as number | undefined,
    autoSelectSymbols: raw["autoSelectSymbols"] as boolean | undefined,
    liquidationBufferPercent: raw["liquidationBufferPercent"] as number | undefined,
    maxDailyLossPercent: raw["maxDailyLossPercent"] as number | false | undefined,
    maxDrawdownHaltPercent: raw["maxDrawdownHaltPercent"] as number | false | undefined,
    maxConsecutiveLosses: raw["maxConsecutiveLosses"] as number | false | undefined,
    maxSlippagePercent: raw["maxSlippagePercent"] as number | false | undefined,
    maxCapitalUsdWarnThreshold: raw["maxCapitalUsdWarnThreshold"] as number | false | undefined,
    riskPerTradePercent: raw["riskPerTradePercent"] as number | undefined,
    atrStopMultiplier: raw["atrStopMultiplier"] as number | undefined,
    cashReservePercent: raw["cashReservePercent"] as number | undefined,
    maxConcurrentPositions: raw["maxConcurrentPositions"] as number | false | undefined,
    maxCorrelation: raw["maxCorrelation"] as number | false | undefined,
    signalConfirmationTicks: raw["signalConfirmationTicks"] as number | undefined,
    minHoldBeforeExpertExitMs: raw["minHoldBeforeExpertExitMs"] as number | undefined,
    estimatedRoundTripFeePercent: raw["estimatedRoundTripFeePercent"] as number | undefined,
  };

  // Validation
  if (!config.exchange || typeof config.exchange !== "string") {
    throw new ConfigError("config.exchange must be a non-empty string");
  }
  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new ConfigError("config.apiKey must be a non-empty string");
  }
  if (!config.apiSecret || typeof config.apiSecret !== "string") {
    throw new ConfigError("config.apiSecret must be a non-empty string");
  }
  if (!Array.isArray(config.symbols) || config.symbols.length === 0) {
    throw new ConfigError("config.symbols must be a non-empty array of strings");
  }
  if (typeof config.maxCapitalUsd !== "number" || config.maxCapitalUsd <= 0) {
    throw new ConfigError("config.maxCapitalUsd must be a positive number — define how much capital you want to operate with");
  }
  if (typeof config.maxPositionSizeUsd !== "number" || config.maxPositionSizeUsd <= 0) {
    throw new ConfigError("config.maxPositionSizeUsd must be a positive number");
  }
  if (config.maxPositionSizeUsd > config.maxCapitalUsd) {
    throw new ConfigError("config.maxPositionSizeUsd cannot exceed config.maxCapitalUsd — you can't risk more than your operating capital per trade");
  }
  if (typeof config.maxDailyTrades !== "number" || config.maxDailyTrades < 0) {
    throw new ConfigError("config.maxDailyTrades must be a non-negative number");
  }
  if (typeof config.stopLossPercent !== "number" || config.stopLossPercent <= 0) {
    throw new ConfigError("config.stopLossPercent must be a positive number");
  }
  if (typeof config.takeProfitPercent !== "number" || config.takeProfitPercent <= 0) {
    throw new ConfigError("config.takeProfitPercent must be a positive number");
  }
  if (typeof config.refreshIntervalMs !== "number" || config.refreshIntervalMs < 1000) {
    throw new ConfigError("config.refreshIntervalMs must be >= 1000");
  }
  if (
    config.liquidationBufferPercent !== undefined &&
    (typeof config.liquidationBufferPercent !== "number" || config.liquidationBufferPercent <= 0 || config.liquidationBufferPercent >= 100)
  ) {
    throw new ConfigError("config.liquidationBufferPercent must be a number between 0 and 100 (exclusive) if set");
  }
  for (const field of ["maxDailyLossPercent", "maxDrawdownHaltPercent", "maxSlippagePercent"] as const) {
    const v = config[field];
    if (v !== undefined && v !== false && (typeof v !== "number" || v <= 0 || v > 100)) {
      throw new ConfigError(`config.${field} must be a number between 0 (exclusive) and 100 (inclusive), or false to disable, if set`);
    }
  }
  if (
    config.maxConsecutiveLosses !== undefined && config.maxConsecutiveLosses !== false &&
    (typeof config.maxConsecutiveLosses !== "number" || config.maxConsecutiveLosses <= 0 || !Number.isInteger(config.maxConsecutiveLosses))
  ) {
    throw new ConfigError("config.maxConsecutiveLosses must be a positive integer, or false to disable, if set");
  }
  if (
    config.maxCapitalUsdWarnThreshold !== undefined && config.maxCapitalUsdWarnThreshold !== false &&
    (typeof config.maxCapitalUsdWarnThreshold !== "number" || config.maxCapitalUsdWarnThreshold <= 0)
  ) {
    throw new ConfigError("config.maxCapitalUsdWarnThreshold must be a positive number, or false to disable, if set");
  }
  if (
    config.riskPerTradePercent !== undefined &&
    (typeof config.riskPerTradePercent !== "number" || config.riskPerTradePercent <= 0 || config.riskPerTradePercent > 100)
  ) {
    throw new ConfigError("config.riskPerTradePercent must be a number between 0 (exclusive) and 100 (inclusive) if set");
  }
  if (config.atrStopMultiplier !== undefined && (typeof config.atrStopMultiplier !== "number" || config.atrStopMultiplier <= 0)) {
    throw new ConfigError("config.atrStopMultiplier must be a positive number if set");
  }
  if (
    config.cashReservePercent !== undefined &&
    (typeof config.cashReservePercent !== "number" || config.cashReservePercent < 0 || config.cashReservePercent >= 100)
  ) {
    throw new ConfigError("config.cashReservePercent must be a number between 0 (inclusive) and 100 (exclusive) if set");
  }
  if (
    config.maxConcurrentPositions !== undefined && config.maxConcurrentPositions !== false &&
    (typeof config.maxConcurrentPositions !== "number" || config.maxConcurrentPositions <= 0 || !Number.isInteger(config.maxConcurrentPositions))
  ) {
    throw new ConfigError("config.maxConcurrentPositions must be a positive integer, or false to disable, if set");
  }
  if (
    config.maxCorrelation !== undefined && config.maxCorrelation !== false &&
    (typeof config.maxCorrelation !== "number" || config.maxCorrelation <= 0 || config.maxCorrelation > 1)
  ) {
    throw new ConfigError("config.maxCorrelation must be a number between 0 (exclusive) and 1 (inclusive), or false to disable, if set");
  }
  if (
    config.signalConfirmationTicks !== undefined &&
    (typeof config.signalConfirmationTicks !== "number" || config.signalConfirmationTicks <= 0 || !Number.isInteger(config.signalConfirmationTicks))
  ) {
    throw new ConfigError("config.signalConfirmationTicks must be a positive integer if set");
  }
  if (
    config.minHoldBeforeExpertExitMs !== undefined &&
    (typeof config.minHoldBeforeExpertExitMs !== "number" || config.minHoldBeforeExpertExitMs < 0)
  ) {
    throw new ConfigError("config.minHoldBeforeExpertExitMs must be a non-negative number if set");
  }
  if (
    config.estimatedRoundTripFeePercent !== undefined &&
    (typeof config.estimatedRoundTripFeePercent !== "number" || config.estimatedRoundTripFeePercent <= 0)
  ) {
    throw new ConfigError("config.estimatedRoundTripFeePercent must be a positive number if set");
  }

  return config as Config;
}