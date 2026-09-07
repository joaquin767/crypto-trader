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

  return config as Config;
}