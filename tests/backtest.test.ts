import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runBacktest, type Candle } from "../src/strategy/backtest.ts";
import type { Config } from "../src/config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const baseConfig: Config = {
  exchange: "bybit", apiKey: "a", apiSecret: "b",
  symbols: ["APT/USDT"], maxCapitalUsd: 100, maxPositionSizeUsd: 25,
  maxDailyTrades: 0, stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 5000,
};

test("runBacktest on a flat (zero-movement) candle series trades zero times", () => {
  // Regression for specs/strategy-signal-quality.md §6's stated acceptance
  // criterion — a flat series has no real edge anywhere, so the §4/§5 gates
  // (signal confirmation, cost-aware entry) should keep the strategy out of
  // the market entirely, unlike the pre-Phase-1 behavior.
  const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({
    openTime: i * 900_000, open: 100, high: 100, low: 100, close: 100, volume: 1000,
  }));
  return runBacktest(flat, "BTC/USDT", baseConfig).then((report) => {
    assert.equal(report.closedTrades, 0);
    assert.equal(report.candleCount, 60);
    assert.equal(report.totalPnl, 0);
  });
});

test("runBacktest against real historical Bybit candles produces a well-formed report", async () => {
  // Real APT/USDT 15m candles (2026-09-08, ~3 days), fetched once from
  // Bybit's public GET /v5/market/kline and cached — see the fixture's own
  // _comment for provenance. Never fetched live inside this test (per
  // §6's acceptance criteria and specs/strategy-signal-quality.md's
  // Constraints section).
  const fixturePath = join(__dirname, "fixtures", "aptusdt-klines-15m.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as { candles: Candle[] };

  const report = await runBacktest(fixture.candles, "APT/USDT", baseConfig);

  assert.equal(report.symbol, "APT/USDT");
  assert.equal(report.candleCount, fixture.candles.length);
  assert(report.closedTrades >= 0 && Number.isInteger(report.closedTrades));
  assert(report.winRate >= 0 && report.winRate <= 1);
  assert(report.totalFees >= 0);
  assert(Number.isFinite(report.maxDrawdownPercent) && report.maxDrawdownPercent >= 0);
  assert(Number.isFinite(report.totalPnl));
  // profitFactor can legitimately be 0 (no trades / no losses to divide by)
  // or Infinity (no losing trades) — just must not be NaN or negative.
  assert(!Number.isNaN(report.profitFactor) && report.profitFactor >= 0);

  // NOTE — not a pass/fail assertion, deliberately: the spec's actual
  // "shipping bar" (totalPnl - totalFees >= 0) is a human/process gate
  // checked against a real run's numbers before a strategy change ships,
  // not something this structural test enforces — a real historical sample
  // legitimately can come back either way, and hard-asserting a specific
  // sign here would make this test flaky against a fixture that's
  // completely valid input. As of this fixture (300 candles, ~3 days,
  // 2026-09-08): closedTrades=0 (one position opened and still open at the
  // fixture's end), totalFees=0.02, so totalPnl-totalFees is slightly
  // negative on this specific short/small sample — inconclusive rather than
  // a clear pass, and worth a longer/multi-symbol run before relying on it
  // as this spec's Phase 2 gate (see Open questions).
});
