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

  return config as Config;
}