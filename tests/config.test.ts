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
