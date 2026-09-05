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
    symbols: ["BTC/USDT"], maxPositionSizeUsd: 100,
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
    symbols: ["BTC/USDT"], maxPositionSizeUsd: 100,
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
    symbols: [], maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
  }));
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});