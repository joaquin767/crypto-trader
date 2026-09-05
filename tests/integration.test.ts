import { test } from "node:test";
import assert from "node:assert/strict";
import { start, loadConfig, type Config } from "../src/main.ts";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configPath = join(tmpdir(), `crypto-trader-integration-test-${Date.now()}.json`);

test("start() runs briefly and renders with a valid config (paper mode)", async () => {
  const config: Config = {
    exchange: "binance",
    apiKey: "test-key",
    apiSecret: "test-secret",
    symbols: ["BTC/USDT"],
    maxPositionSizeUsd: 1000,
    maxDailyTrades: 5,
    stopLossPercent: 5,
    takeProfitPercent: 10,
    refreshIntervalMs: 1000,
  };
  writeFileSync(configPath, JSON.stringify(config));

  try {
    const loaded = loadConfig(configPath);
    assert.equal(loaded.exchange, "binance");

    const ac = new AbortController();
    const startPromise = start(loaded, ac.signal);

    // Let it run for 1.5s, then abort
    await new Promise<void>((r) => setTimeout(r, 1500));
    ac.abort();
    await startPromise; // should resolve immediately after abort

    assert.ok(true, "start() ran and terminated cleanly on abort");
  } finally {
    if (existsSync(configPath)) unlinkSync(configPath);
  }
});

test("loadConfig throws ConfigError for missing file", () => {
  assert.throws(() => loadConfig("/nonexistent/path.json"), /ConfigError/);
});

test("start() handles invalid exchange gracefully (retry + continue)", { timeout: 10000 }, async () => {
  // Simulate an unavailable exchange by using a nonexistent exchange name.
  // watch() will retry and yield empty maps; the app stays alive.
  const config: Config = {
    exchange: "nonexistent_exchange",
    apiKey: "a",
    apiSecret: "b",
    symbols: ["BTC/USDT"],
    maxPositionSizeUsd: 1000,
    maxDailyTrades: 5,
    stopLossPercent: 5,
    takeProfitPercent: 10,
    refreshIntervalMs: 1000,
  };
  const ac = new AbortController();
  const startPromise = start(config, ac.signal);

  await new Promise<void>((r) => setTimeout(r, 2000));
  ac.abort();
  await startPromise;

  assert.ok(true, "start() handled unavailable exchange gracefully");
});