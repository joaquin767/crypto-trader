import { readFileSync } from "node:fs";

import type { AiAnalystConfig } from "./research/ai/types.ts";

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

  // ── Learned entry model (src/strategy/model.ts) ───────────────────────
  /** Gate new entries on the trained model's probability. Default false —
   *  the model is opt-in, and with it off the strategy behaves exactly as
   *  it did before the model existed. Requires a weights file (train with
   *  scripts/train-model.ts); if none loads, this has no effect and a
   *  warning is logged once rather than silently gating nothing. */
  useModelGate?: boolean;
  /** Minimum model probability required to open a position when
   *  useModelGate is on. Default 0.5. Higher = trade less, more
   *  selectively — tune against runBacktest(), not by feel. */
  modelMinProbability?: number;
  /** Enter only when the model's score is in the top N PERCENT of the
   *  scores it produces for that symbol over its own recent history.
   *
   *  Prefer this to modelMinProbability. An absolute probability does not
   *  transfer between symbols or regimes: this model was fit on a ~26%
   *  positive base rate so its outputs cluster near 0.26, and the observed
   *  ceiling was 0.468 on APT but 0.284 on SOL — a "p >= 0.55" rule tuned
   *  on a backtest window silently meant "never trade" live. A percentile
   *  adapts to whatever distribution the model actually produces.
   *
   *  When set, this overrides modelMinProbability. Default unset. */
  modelTopPercentile?: number;

  /** Simulated MAKER fee (% of notional) charged by the paper executor when
   *  an entry rests as post-only. Default 0.02 — Bybit standard non-VIP
   *  linear perpetual, confirmed against a real testnet fill. */
  simulatedMakerFeePercent?: number;
  /** Simulated TAKER fee (% of notional). Default 0.055, likewise measured.
   *  Every close pays this, because closes always go to market — so a
   *  post-only round trip costs maker + taker (0.075%), NOT 2x maker. */
  simulatedTakerFeePercent?: number;

  // ── Maker (post-only) entries ─────────────────────────────────────────
  /** Place ENTRIES as post-only limit orders resting at the near touch
   *  instead of market orders. On Bybit's standard tier this pays the maker
   *  fee (0.02%/side) rather than taker (0.055%/side) — a ~2.75x cut in
   *  round-trip cost, which measurably dominates this strategy's edge.
   *
   *  The tradeoff is fill certainty: a post-only order that would cross the
   *  spread is rejected by the exchange, and one that rests may never fill
   *  if price walks away. Unfilled orders are cancelled after
   *  postOnlyTimeoutMs and reported as a no-op.
   *
   *  CLOSES ARE NEVER POST-ONLY, regardless of this setting — a stop-loss
   *  that sits unfilled while price runs against the position is precisely
   *  the failure mode the risk logic exists to prevent. Default false. */
  usePostOnlyEntries?: boolean;
  /** Exit TAKE-PROFITS as post-only limit orders, earning the maker rate
   *  (0.02%/side) instead of taker (0.055%). Default false.
   *
   *  This is the natural shape of a take-profit: a resting limit sell ABOVE
   *  the market is a maker order by construction, so it costs nothing in
   *  realism to model it as one. With it on, a round trip that ends in
   *  take-profit costs 0.04% instead of 0.075%, which moves the break-even
   *  win rate at symmetric 1.5% barriers from 52.5% to 51.3%.
   *
   *  APPLIES TO TAKE-PROFIT EXITS ONLY. Stop-loss and horizon exits are
   *  always taker, regardless of this setting, and that is not a tunable:
   *  a stop-loss resting unfilled while price runs against the position is
   *  precisely the failure mode the risk logic exists to prevent (the same
   *  invariant documented on usePostOnlyEntries), and a horizon exit is a
   *  forced close whose entire purpose is that it happens on time.
   *
   *  Modelling caveat, stated rather than hidden: the backtest fills a
   *  resting take-profit whenever a bar's HIGH reaches the level. A real
   *  limit order at the touch may not fill, because OHLC cannot model queue
   *  position — so this is an upper bound on the benefit, biased in favour
   *  of the feature. The same caveat applies to the post-only entry model. */
  usePostOnlyTakeProfitExits?: boolean;
  /** How long to let an unfilled post-only entry rest before cancelling it.
   *  Default 5000ms. */
  postOnlyTimeoutMs?: number;
  /** How many bars a post-only entry may rest in the BACKTEST before it is
   *  cancelled unfilled. Default 1.
   *
   *  This is the backtest's analogue of postOnlyTimeoutMs, and the two
   *  should describe the same duration: postOnlyTimeoutMs should be roughly
   *  postOnlyRestBars x the bar interval. Note that the live default of
   *  5000ms against a 5-minute bar is 1.7% of a bar — a resting time so
   *  short it is barely modellable here, and arguably too short to be
   *  worth resting at all. See the fill-model note in backtest.ts. */
  postOnlyRestBars?: number;
  /** Half-spread (percent of price) a post-only order rests behind the last
   *  trade, since it sits at the bid rather than at the close. Default 0.01,
   *  measured from APT/USDT's observed ~0.0156% testnet spread. */
  postOnlyHalfSpreadPercent?: number;

  // ── Daily catalyst manual trading (specs/daily-catalyst-manual-trading.md §5.11) ──────────
  /** Manual trading pipeline settings (research:daily / planner / journal). Presence of this
   *  key (even `{}`) turns on the revision-1 hard cap: riskPerTradePercent <= 1. */
  manual?: Partial<ManualTradingConfig>;

  /** AI analyst channel settings (specs/daily-catalyst-manual-trading.md §5.11, §5.13).
   *  The API key is never read from here — only from `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
   *  or the SDK's default credential chain (§5.11). */
  ai?: Partial<AiAnalystConfig>;

  /** Persona decision channel settings (specs/daily-catalyst-manual-trading.md §5.11, §5.15,
   *  revision 3). There is no `enabled` flag: the channel is a CLI (`npm run decide`) the owner
   *  runs by hand, so not running it is how it stays off. No credential and no network is
   *  involved. */
  persona?: Partial<PersonaConfig>;
}

/** specs/daily-catalyst-manual-trading.md §5.11 (revision 3). Every field has a spec-defined
 *  default, so `config.persona` may be a partial override of any subset of them. */
export interface PersonaConfig {
  executionWindowMs: number; // > 0, default 21_600_000 (6 h). The Plan Report's execute window: decidedAt + this (§13 A29)
  maxEntryGapAtr: number; // > 0, default 0.25. Gap rule: skip the entry if |mark − referencePrice| > this × atr14d (§13 A30)
  channelStatus: "experimental" | "paper-passed"; // default "experimental"; owner-edited after the persona channel's Gate D1 (§8.5)
  passedSkillHash: string | null; // default null; loadConfig throws ConfigError when channelStatus is "paper-passed" and this is null
  ownerTimeZone: string; // IANA zone for the Plan Report's second clock column, default "America/Argentina/Buenos_Aires" (UTC−3)
  decisionsRoot: string; // default "data/decisions"
  skillRoot: string; // default ".claude/skills/crypto-fundamental-analyst" — the skillHash input root (§5.15)
}

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  executionWindowMs: 21_600_000,
  maxEntryGapAtr: 0.25,
  channelStatus: "experimental",
  passedSkillHash: null,
  ownerTimeZone: "America/Argentina/Buenos_Aires",
  decisionsRoot: "data/decisions",
  skillRoot: ".claude/skills/crypto-fundamental-analyst",
};

/** Merges `config.persona` (if any) over the spec's revision-3 defaults. loadConfig already
 *  validated any override present, so this never throws. */
export function resolvePersonaConfig(config: Pick<Config, "persona">): PersonaConfig {
  return { ...DEFAULT_PERSONA_CONFIG, ...config.persona };
}

/** specs/daily-catalyst-manual-trading.md §5.11. Every field has a spec-defined default, so
 *  `config.manual` may be a partial override of any subset of them. */
export interface ManualTradingConfig {
  maxLeverage: number; // integer 1..5, default 2
  liveLadderCap: number; // integer 1..maxLeverage, default 2
  // riskPerTradePercent (existing Config field) is validated <= 1 whenever `manual` is present (revision 1 hard cap)
  marginBudgetPercent: number; // (0,100], default 25
  maintenanceMarginRate: number; // default 0.005
  minLiqToStopRatio: number; // >= 1.5, default 2.0
  roundTripFeePercent: number; // default 0.11
  maxOpenManualTrades: number; // integer 1..5, default 3
  decisionTimeUtc: "00:15"; // fixed in revision 1
  staleAfterMs: number; // dashboard sync staleness, default 120_000
  syncIntervalMs: number; // live sync cadence, default 30_000, >= 10_000
  journalStartTime: string | null; // ISO-8601 UTC; required for live sync (§5.8a), default null
  fundingSignVerified: boolean; // default false; owner sets true after §12.13
  breakerResetAt: string | null; // ISO-8601 UTC; owner-set to clear drawdown/consecutiveLosses latches (§5.8a), default null
  journalPort: number; // default 3082
  notifyOnReport: boolean; // default false; desktop notification when research:daily writes a report (§5.16), overridable per run with --notify
}

export const DEFAULT_MANUAL_TRADING_CONFIG: ManualTradingConfig = {
  maxLeverage: 2,
  liveLadderCap: 2,
  marginBudgetPercent: 25,
  maintenanceMarginRate: 0.005,
  minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11,
  maxOpenManualTrades: 3,
  decisionTimeUtc: "00:15",
  staleAfterMs: 120_000,
  syncIntervalMs: 30_000,
  journalStartTime: null,
  fundingSignVerified: false,
  breakerResetAt: null,
  journalPort: 3082,
  notifyOnReport: false,
};

/** Merges `config.manual` (if any) over the spec's revision-1 defaults. loadConfig already
 *  validated any override present, so this never throws. */
export function resolveManualTradingConfig(config: Pick<Config, "manual">): ManualTradingConfig {
  return { ...DEFAULT_MANUAL_TRADING_CONFIG, ...config.manual };
}

export type { AiAnalystConfig } from "./research/ai/types.ts";

/** specs/daily-catalyst-manual-trading.md §5.11. Every field has a spec-defined default, so
 *  `config.ai` may be a partial override of any subset of them. `channelStatus`/`passedPromptHash`
 *  are the owner-edited Gate D1 record for the AI channel (§8.4) — they start conservative
 *  (`"experimental"`, `null`) so a fresh checkout never runs the AI channel at anything but
 *  leverage 1 / paper venue. */
export const DEFAULT_AI_ANALYST_CONFIG: AiAnalystConfig = {
  enabled: false,
  provider: "claude-cli",
  cliPath: null,
  model: "claude-opus-5",
  effort: "high",
  maxTokens: 32_000,
  webSearchMaxUses: 5,
  maxIdeasPerDay: 3,
  monthlyBudgetUsd: 15,
  inputUsdPerMTok: 5,
  outputUsdPerMTok: 25,
  webSearchUsdPerRequest: 0.01,
  channelStatus: "experimental",
  passedPromptHash: null,
  timeoutMs: 600_000,
};

/** Merges `config.ai` (if any) over the spec's revision-1 defaults. loadConfig already
 *  validated any override present, so this never throws. */
export function resolveAiAnalystConfig(config: Pick<Config, "ai">): AiAnalystConfig {
  return { ...DEFAULT_AI_ANALYST_CONFIG, ...config.ai };
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
    useModelGate: raw["useModelGate"] as boolean | undefined,
    modelMinProbability: raw["modelMinProbability"] as number | undefined,
    modelTopPercentile: raw["modelTopPercentile"] as number | undefined,
    simulatedMakerFeePercent: raw["simulatedMakerFeePercent"] as number | undefined,
    simulatedTakerFeePercent: raw["simulatedTakerFeePercent"] as number | undefined,
    usePostOnlyEntries: raw["usePostOnlyEntries"] as boolean | undefined,
    usePostOnlyTakeProfitExits: raw["usePostOnlyTakeProfitExits"] as boolean | undefined,
    postOnlyTimeoutMs: raw["postOnlyTimeoutMs"] as number | undefined,
    postOnlyRestBars: raw["postOnlyRestBars"] as number | undefined,
    postOnlyHalfSpreadPercent: raw["postOnlyHalfSpreadPercent"] as number | undefined,
  };
  // Assigned conditionally (not inline above, unlike every other optional field) so an absent
  // `manual` key never becomes an explicit `manual: undefined` own-property on the returned
  // object — tests/config.test.ts's exhaustive round-trip test asserts deepEqual against a raw
  // fixture that (correctly) omits keys it never set, and `assert/strict`'s deepEqual does
  // distinguish an explicit `undefined` value from a genuinely absent key.
  if (raw["manual"] !== undefined) {
    config.manual = raw["manual"] as Partial<ManualTradingConfig>;
  }
  if (raw["ai"] !== undefined) {
    config.ai = raw["ai"] as Partial<AiAnalystConfig>;
  }
  if (raw["persona"] !== undefined) {
    config.persona = raw["persona"] as Partial<PersonaConfig>;
  }

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
  if (config.useModelGate !== undefined && typeof config.useModelGate !== "boolean") {
    throw new ConfigError("config.useModelGate must be a boolean if set");
  }
  if (
    config.modelMinProbability !== undefined &&
    (typeof config.modelMinProbability !== "number" || config.modelMinProbability <= 0 || config.modelMinProbability >= 1)
  ) {
    throw new ConfigError("config.modelMinProbability must be a number between 0 and 1 (exclusive) if set");
  }
  if (
    config.modelTopPercentile !== undefined &&
    (typeof config.modelTopPercentile !== "number" || config.modelTopPercentile <= 0 || config.modelTopPercentile >= 100)
  ) {
    throw new ConfigError("config.modelTopPercentile must be a number between 0 and 100 (exclusive) if set");
  }
  for (const field of ["simulatedMakerFeePercent", "simulatedTakerFeePercent"] as const) {
    const v = config[field];
    if (v !== undefined && (typeof v !== "number" || v < 0)) {
      throw new ConfigError(`config.${field} must be a non-negative number if set`);
    }
  }
  if (config.usePostOnlyTakeProfitExits !== undefined && typeof config.usePostOnlyTakeProfitExits !== "boolean") {
    throw new ConfigError("config.usePostOnlyTakeProfitExits must be a boolean if set");
  }
  if (config.usePostOnlyEntries !== undefined && typeof config.usePostOnlyEntries !== "boolean") {
    throw new ConfigError("config.usePostOnlyEntries must be a boolean if set");
  }
  if (
    config.postOnlyTimeoutMs !== undefined &&
    (typeof config.postOnlyTimeoutMs !== "number" || config.postOnlyTimeoutMs <= 0)
  ) {
    throw new ConfigError("config.postOnlyTimeoutMs must be a positive number if set");
  }
  if (
    config.postOnlyRestBars !== undefined &&
    (typeof config.postOnlyRestBars !== "number" || config.postOnlyRestBars < 1 || !Number.isInteger(config.postOnlyRestBars))
  ) {
    throw new ConfigError("config.postOnlyRestBars must be a positive integer if set");
  }
  if (
    config.postOnlyHalfSpreadPercent !== undefined &&
    (typeof config.postOnlyHalfSpreadPercent !== "number" || config.postOnlyHalfSpreadPercent < 0)
  ) {
    throw new ConfigError("config.postOnlyHalfSpreadPercent must be a non-negative number if set");
  }

  if (config.manual !== undefined) {
    validateManualTradingConfig(config.manual);
    // Revision-1 hard cap (§5.11): presence of `manual` forces the existing riskPerTradePercent
    // field down to <= 1, regardless of the 100-cap validated above for the base scalper.
    if (config.riskPerTradePercent !== undefined && config.riskPerTradePercent > 1) {
      throw new ConfigError("config.riskPerTradePercent must be <= 1 when config.manual is present (revision 1 hard cap)");
    }
  }
  if (config.ai !== undefined) {
    validateAiAnalystConfig(config.ai);
  }
  if (config.persona !== undefined) {
    validatePersonaConfig(config.persona);
  }

  return config as Config;
}

function validateManualTradingConfig(manual: Partial<ManualTradingConfig>): void {
  if (manual.maxLeverage !== undefined) {
    if (typeof manual.maxLeverage !== "number" || !Number.isInteger(manual.maxLeverage) || manual.maxLeverage < 1 || manual.maxLeverage > 5) {
      throw new ConfigError("config.manual.maxLeverage must be an integer in 1..5 if set");
    }
  }
  const effectiveMaxLeverage = manual.maxLeverage ?? DEFAULT_MANUAL_TRADING_CONFIG.maxLeverage;
  if (manual.liveLadderCap !== undefined) {
    if (
      typeof manual.liveLadderCap !== "number" || !Number.isInteger(manual.liveLadderCap) ||
      manual.liveLadderCap < 1 || manual.liveLadderCap > effectiveMaxLeverage
    ) {
      throw new ConfigError(`config.manual.liveLadderCap must be an integer in 1..${effectiveMaxLeverage} (config.manual.maxLeverage) if set`);
    }
  }
  if (manual.marginBudgetPercent !== undefined) {
    if (typeof manual.marginBudgetPercent !== "number" || manual.marginBudgetPercent <= 0 || manual.marginBudgetPercent > 100) {
      throw new ConfigError("config.manual.marginBudgetPercent must be a number in (0, 100] if set");
    }
  }
  if (manual.maintenanceMarginRate !== undefined) {
    if (typeof manual.maintenanceMarginRate !== "number" || manual.maintenanceMarginRate <= 0) {
      throw new ConfigError("config.manual.maintenanceMarginRate must be a positive number if set");
    }
  }
  if (manual.minLiqToStopRatio !== undefined) {
    if (typeof manual.minLiqToStopRatio !== "number" || manual.minLiqToStopRatio < 1.5) {
      throw new ConfigError("config.manual.minLiqToStopRatio must be a number >= 1.5 if set");
    }
  }
  if (manual.roundTripFeePercent !== undefined) {
    if (typeof manual.roundTripFeePercent !== "number" || manual.roundTripFeePercent < 0) {
      throw new ConfigError("config.manual.roundTripFeePercent must be a non-negative number if set");
    }
  }
  if (manual.maxOpenManualTrades !== undefined) {
    if (
      typeof manual.maxOpenManualTrades !== "number" || !Number.isInteger(manual.maxOpenManualTrades) ||
      manual.maxOpenManualTrades < 1 || manual.maxOpenManualTrades > 5
    ) {
      throw new ConfigError("config.manual.maxOpenManualTrades must be an integer in 1..5 if set");
    }
  }
  if (manual.decisionTimeUtc !== undefined && manual.decisionTimeUtc !== "00:15") {
    throw new ConfigError('config.manual.decisionTimeUtc must be "00:15" (fixed in revision 1) if set');
  }
  if (manual.staleAfterMs !== undefined) {
    if (typeof manual.staleAfterMs !== "number" || manual.staleAfterMs <= 0) {
      throw new ConfigError("config.manual.staleAfterMs must be a positive number if set");
    }
  }
  if (manual.journalPort !== undefined) {
    if (
      typeof manual.journalPort !== "number" || !Number.isInteger(manual.journalPort) ||
      manual.journalPort < 1 || manual.journalPort > 65535
    ) {
      throw new ConfigError("config.manual.journalPort must be an integer port number if set");
    }
  }
  if (manual.syncIntervalMs !== undefined) {
    if (typeof manual.syncIntervalMs !== "number" || manual.syncIntervalMs < 10_000) {
      throw new ConfigError("config.manual.syncIntervalMs must be a number >= 10000 if set");
    }
  }
  if (manual.journalStartTime !== undefined && manual.journalStartTime !== null) {
    if (typeof manual.journalStartTime !== "string" || Number.isNaN(Date.parse(manual.journalStartTime))) {
      throw new ConfigError("config.manual.journalStartTime must be an ISO-8601 date string or null if set");
    }
  }
  if (manual.fundingSignVerified !== undefined && typeof manual.fundingSignVerified !== "boolean") {
    throw new ConfigError("config.manual.fundingSignVerified must be a boolean if set");
  }
  if (manual.breakerResetAt !== undefined && manual.breakerResetAt !== null) {
    if (typeof manual.breakerResetAt !== "string" || Number.isNaN(Date.parse(manual.breakerResetAt))) {
      throw new ConfigError("config.manual.breakerResetAt must be an ISO-8601 date string or null if set");
    }
  }
  if (manual.notifyOnReport !== undefined && typeof manual.notifyOnReport !== "boolean") {
    throw new ConfigError("config.manual.notifyOnReport must be a boolean if set");
  }
}

const AI_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const AI_CHANNEL_STATUSES = ["experimental", "paper-passed"] as const;
const AI_PROVIDERS = ["claude-cli", "anthropic-api"] as const;

function validateAiAnalystConfig(ai: Partial<AiAnalystConfig>): void {
  if (ai.enabled !== undefined && typeof ai.enabled !== "boolean") {
    throw new ConfigError("config.ai.enabled must be a boolean if set");
  }
  if (ai.provider !== undefined && !(AI_PROVIDERS as readonly string[]).includes(ai.provider)) {
    throw new ConfigError(`config.ai.provider must be one of ${AI_PROVIDERS.join(", ")} if set`);
  }
  if (ai.cliPath !== undefined && ai.cliPath !== null && typeof ai.cliPath !== "string") {
    throw new ConfigError("config.ai.cliPath must be a string or null if set");
  }
  if (ai.model !== undefined && (typeof ai.model !== "string" || ai.model.length === 0)) {
    throw new ConfigError("config.ai.model must be a non-empty string if set");
  }
  if (ai.effort !== undefined && !(AI_EFFORT_LEVELS as readonly string[]).includes(ai.effort)) {
    throw new ConfigError(`config.ai.effort must be one of ${AI_EFFORT_LEVELS.join(", ")} if set`);
  }
  if (ai.maxTokens !== undefined) {
    if (typeof ai.maxTokens !== "number" || !Number.isInteger(ai.maxTokens) || ai.maxTokens <= 0) {
      throw new ConfigError("config.ai.maxTokens must be a positive integer if set");
    }
  }
  if (ai.webSearchMaxUses !== undefined) {
    if (
      typeof ai.webSearchMaxUses !== "number" || !Number.isInteger(ai.webSearchMaxUses) ||
      ai.webSearchMaxUses < 0 || ai.webSearchMaxUses > 10
    ) {
      throw new ConfigError("config.ai.webSearchMaxUses must be an integer in 0..10 if set");
    }
  }
  if (ai.maxIdeasPerDay !== undefined) {
    if (
      typeof ai.maxIdeasPerDay !== "number" || !Number.isInteger(ai.maxIdeasPerDay) ||
      ai.maxIdeasPerDay < 0 || ai.maxIdeasPerDay > 3
    ) {
      throw new ConfigError("config.ai.maxIdeasPerDay must be an integer in 0..3 if set");
    }
  }
  if (ai.monthlyBudgetUsd !== undefined && (typeof ai.monthlyBudgetUsd !== "number" || ai.monthlyBudgetUsd <= 0)) {
    throw new ConfigError("config.ai.monthlyBudgetUsd must be a positive number if set");
  }
  for (const field of ["inputUsdPerMTok", "outputUsdPerMTok", "webSearchUsdPerRequest"] as const) {
    const v = ai[field];
    if (v !== undefined && (typeof v !== "number" || v < 0)) {
      throw new ConfigError(`config.ai.${field} must be a non-negative number if set`);
    }
  }
  if (ai.channelStatus !== undefined && !(AI_CHANNEL_STATUSES as readonly string[]).includes(ai.channelStatus)) {
    throw new ConfigError(`config.ai.channelStatus must be one of ${AI_CHANNEL_STATUSES.join(", ")} if set`);
  }
  if (ai.passedPromptHash !== undefined && ai.passedPromptHash !== null && typeof ai.passedPromptHash !== "string") {
    throw new ConfigError("config.ai.passedPromptHash must be a string or null if set");
  }
  if (ai.channelStatus === "paper-passed" && (ai.passedPromptHash ?? null) === null) {
    throw new ConfigError('config.ai.passedPromptHash must be set when config.ai.channelStatus is "paper-passed" (§5.11)');
  }
  if (ai.timeoutMs !== undefined && (typeof ai.timeoutMs !== "number" || ai.timeoutMs <= 0)) {
    throw new ConfigError("config.ai.timeoutMs must be a positive number if set");
  }
}

const PERSONA_CHANNEL_STATUSES = ["experimental", "paper-passed"] as const;

function validatePersonaConfig(persona: Partial<PersonaConfig>): void {
  if (persona.executionWindowMs !== undefined && (typeof persona.executionWindowMs !== "number" || persona.executionWindowMs <= 0)) {
    throw new ConfigError("config.persona.executionWindowMs must be a positive number if set");
  }
  if (persona.maxEntryGapAtr !== undefined && (typeof persona.maxEntryGapAtr !== "number" || persona.maxEntryGapAtr <= 0)) {
    throw new ConfigError("config.persona.maxEntryGapAtr must be a positive number if set");
  }
  if (persona.channelStatus !== undefined && !(PERSONA_CHANNEL_STATUSES as readonly string[]).includes(persona.channelStatus)) {
    throw new ConfigError(`config.persona.channelStatus must be one of ${PERSONA_CHANNEL_STATUSES.join(", ")} if set`);
  }
  if (persona.passedSkillHash !== undefined && persona.passedSkillHash !== null && typeof persona.passedSkillHash !== "string") {
    throw new ConfigError("config.persona.passedSkillHash must be a string or null if set");
  }
  if (persona.channelStatus === "paper-passed" && (persona.passedSkillHash ?? null) === null) {
    throw new ConfigError('config.persona.passedSkillHash must be set when config.persona.channelStatus is "paper-passed" (§5.11)');
  }
  if (persona.ownerTimeZone !== undefined && (typeof persona.ownerTimeZone !== "string" || persona.ownerTimeZone.length === 0)) {
    throw new ConfigError("config.persona.ownerTimeZone must be a non-empty string if set");
  }
  if (persona.decisionsRoot !== undefined && (typeof persona.decisionsRoot !== "string" || persona.decisionsRoot.length === 0)) {
    throw new ConfigError("config.persona.decisionsRoot must be a non-empty string if set");
  }
  if (persona.skillRoot !== undefined && (typeof persona.skillRoot !== "string" || persona.skillRoot.length === 0)) {
    throw new ConfigError("config.persona.skillRoot must be a non-empty string if set");
  }
}