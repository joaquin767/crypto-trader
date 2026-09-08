import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError, type Config } from "../src/config.ts";

const tmp = (name: string) => join(tmpdir(), `crypto-trader-test-${name}-${Date.now()}.json`);

test("loadConfig loads a valid config file", () => {
  const path = tmp("valid");
  const data: Config = {
    exchange: "binance",
    apiKey: "abc123",
    apiSecret: "secret456",
    symbols: ["BTC/USDT", "ETH/USDT"],
    maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
    maxDailyTrades: 5,
    stopLossPercent: 5,
    takeProfitPercent: 10,
    refreshIntervalMs: 5000,
  };
  writeFileSync(path, JSON.stringify(data));
  try {
    const result = loadConfig(path);
    assert.equal(result.exchange, "binance");
    assert.deepEqual(result.symbols, ["BTC/USDT", "ETH/USDT"]);
    assert.equal(result.maxDailyTrades, 5);
    assert.equal(result.refreshIntervalMs, 5000);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on missing file", () => {
  assert.throws(() => loadConfig("/nonexistent/path.json"), ConfigError);
});

test("loadConfig throws ConfigError on invalid JSON", () => {
  const path = tmp("badjson");
  writeFileSync(path, "not json");
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on negative stopLossPercent", () => {
  const path = tmp("negstoploss");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
  maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: -1, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on refreshIntervalMs < 1000", () => {
  const path = tmp("badinterval");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
  maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 500,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on empty symbols", () => {
  const path = tmp("emptysym");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: [], maxCapitalUsd: 100,
  maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});
test("loadConfig throws ConfigError when maxPositionSizeUsd exceeds maxCapitalUsd", () => {
  const path = tmp("possize");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 200,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on negative maxDailyTrades", () => {
  const path = tmp("negdaily");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: -1, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on non-positive maxCapitalUsd", () => {
  const path = tmp("negcap");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 0,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on negative takeProfitPercent", () => {
  const path = tmp("negtakeprofit");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: -1, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on missing exchange", () => {
  const path = tmp("noexchange");
  writeFileSync(path, JSON.stringify({
    apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

// Regression coverage for a real bug: loadConfig built its Config object from a
// hand-picked list of raw JSON fields that didn't include "autoSelectSymbols" — the
// field was silently dropped (always undefined) no matter what config.json said, with
// no error and no warning. This test round-trips every field declared on the Config
// interface through loadConfig and deep-equals the result, so a future field that's
// added to the interface but not wired into the parser's field list fails loudly here
// instead of silently doing nothing. When adding a field to Config, add it here too —
// that's the point: the test forces a conscious decision, not an accidental omission.
test("loadConfig round-trips every Config field (regression: a field can silently be dropped)", () => {
  const path = tmp("roundtrip");
  const raw = {
    exchange: "bybit",
    apiKey: "sentinel-key",
    apiSecret: "sentinel-secret",
    symbols: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    maxCapitalUsd: 12345,
    maxPositionSizeUsd: 6789,
    maxDailyTrades: 42,
    stopLossPercent: 7.5,
    takeProfitPercent: 12.5,
    refreshIntervalMs: 9000,
    autoSelectSymbols: true,
    liquidationBufferPercent: 20,
    maxDailyLossPercent: 12,
    maxDrawdownHaltPercent: 25,
    maxConsecutiveLosses: 7,
    maxSlippagePercent: false as const,
    maxCapitalUsdWarnThreshold: 750,
    riskPerTradePercent: 1.5,
    atrStopMultiplier: 2.5,
    cashReservePercent: 8,
    maxConcurrentPositions: 3,
    maxCorrelation: 0.75,
    signalConfirmationTicks: 3,
    minHoldBeforeExpertExitMs: 45000,
    estimatedRoundTripFeePercent: 0.18,
    useModelGate: true,
    modelMinProbability: 0.62,
    modelTopPercentile: 5,
    simulatedMakerFeePercent: 0.02,
    simulatedTakerFeePercent: 0.055,
    usePostOnlyEntries: true,
    postOnlyTimeoutMs: 4000,
    postOnlyRestBars: 2,
    postOnlyHalfSpreadPercent: 0.015,
  };
  writeFileSync(path, JSON.stringify(raw));
  try {
    const result = loadConfig(path);
    assert.deepEqual(result, raw);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on out-of-range liquidationBufferPercent", () => {
  const path = tmp("badliqbuffer");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
    liquidationBufferPercent: 150,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on out-of-range maxDailyLossPercent", () => {
  const path = tmp("baddailyloss");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
    maxDailyLossPercent: 0,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig accepts `false` for a circuit-breaker field to disable it", () => {
  const path = tmp("disabledbreaker");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
    maxDrawdownHaltPercent: false,
  }));
  try {
    const result = loadConfig(path);
    assert.equal(result.maxDrawdownHaltPercent, false);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on non-integer maxConsecutiveLosses", () => {
  const path = tmp("badconsecutive");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
    maxConsecutiveLosses: 2.5,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on out-of-range riskPerTradePercent", () => {
  const path = tmp("badriskpertrade");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
    riskPerTradePercent: 0,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on non-integer maxConcurrentPositions", () => {
  const path = tmp("badconcurrent");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
    maxConcurrentPositions: 1.5,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on out-of-range maxCorrelation", () => {
  const path = tmp("badcorrelation");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
    maxCorrelation: 1.5,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("loadConfig throws ConfigError on missing apiKey", () => {
  const path = tmp("noapikey");
  writeFileSync(path, JSON.stringify({
    exchange: "binance", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 100,
    maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});
