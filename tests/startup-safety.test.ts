import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalThresholdToWarn, assertCapitalThresholdOk, StartupSafetyError, CONFIRMATION_PHRASE } from "../src/startup-safety.ts";
import type { Config } from "../src/config.ts";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    exchange: "bybit", apiKey: "a", apiSecret: "b",
    symbols: ["BTC/USDT"], maxCapitalUsd: 1000, maxPositionSizeUsd: 100,
    maxDailyTrades: 5, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
    ...overrides,
  };
}

const noopLogger = { warn: () => {}, error: () => {} };

test("capitalThresholdToWarn is null for paper/testnet mode regardless of capital", () => {
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 999999 }), "paper"), null);
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 999999 }), "testnet"), null);
});

test("capitalThresholdToWarn is null when live capital is at or below the default threshold", () => {
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 500 }), "live"), null);
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 100 }), "live"), null);
});

test("capitalThresholdToWarn returns the default threshold when live capital exceeds it", () => {
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 501 }), "live"), 500);
});

test("capitalThresholdToWarn respects a custom threshold", () => {
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 200, maxCapitalUsdWarnThreshold: 100 }), "live"), 100);
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 50, maxCapitalUsdWarnThreshold: 100 }), "live"), null);
});

test("capitalThresholdToWarn is null when explicitly disabled", () => {
  assert.equal(capitalThresholdToWarn(baseConfig({ maxCapitalUsd: 999999, maxCapitalUsdWarnThreshold: false }), "live"), null);
});

test("assertCapitalThresholdOk resolves silently when no gate applies", async () => {
  await assertCapitalThresholdOk(baseConfig({ maxCapitalUsd: 100 }), "live", noopLogger, true, async () => "irrelevant");
});

test("assertCapitalThresholdOk throws non-interactively even with no prompt attempted", async () => {
  await assert.rejects(
    () => assertCapitalThresholdOk(baseConfig({ maxCapitalUsd: 1000 }), "live", noopLogger, false, async () => {
      throw new Error("must not be called when non-interactive");
    }),
    StartupSafetyError,
  );
});

test("assertCapitalThresholdOk resolves when the interactive prompt matches the exact phrase", async () => {
  await assertCapitalThresholdOk(baseConfig({ maxCapitalUsd: 1000 }), "live", noopLogger, true, async () => CONFIRMATION_PHRASE);
});

test("assertCapitalThresholdOk throws when the interactive prompt doesn't match", async () => {
  await assert.rejects(
    () => assertCapitalThresholdOk(baseConfig({ maxCapitalUsd: 1000 }), "live", noopLogger, true, async () => "yes"),
    StartupSafetyError,
  );
});

test("assertCapitalThresholdOk trims whitespace but requires an exact phrase match", async () => {
  await assertCapitalThresholdOk(baseConfig({ maxCapitalUsd: 1000 }), "live", noopLogger, true, async () => `  ${CONFIRMATION_PHRASE}  `);
  await assert.rejects(
    () => assertCapitalThresholdOk(baseConfig({ maxCapitalUsd: 1000 }), "live", noopLogger, true, async () => CONFIRMATION_PHRASE.toLowerCase()),
    StartupSafetyError,
  );
});
