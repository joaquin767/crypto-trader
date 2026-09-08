import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runBacktest, type Candle } from "../src/strategy/backtest.ts";
import type { Config } from "../src/config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// runBacktest used to assume every post-only entry filled at the decision
// bar's close. That is false in the direction that flatters results: a
// resting bid fills only when price trades DOWN to it, so you fill when the
// market comes back and miss when it runs away — capturing losers, skipping
// winners. Observed live 2026-09-08: six consecutive post-only entries
// failed to fill while APT rose, then one filled when price came back.

const base: Config = {
  exchange: "bybit", apiKey: "a", apiSecret: "b", symbols: [],
  maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 0,
  refreshIntervalMs: 5000, stopLossPercent: 1, takeProfitPercent: 1,
  simulatedMakerFeePercent: 0.02, simulatedTakerFeePercent: 0.055,
  useModelGate: true, modelMinProbability: 0.5,
  usePostOnlyEntries: true, postOnlyRestBars: 1,
};

function realCandles(): Candle[] {
  const f = JSON.parse(readFileSync(join(__dirname, "fixtures", "aptusdt-klines-15m.json"), "utf-8")) as { candles: Candle[] };
  return f.candles;
}

test("a resting bid deep below the market fills far less often than one at the touch", async () => {
  const candles = realCandles();
  const atTouch = await runBacktest(candles, "APT/USDT", { ...base, postOnlyHalfSpreadPercent: 0.01 });
  const deep = await runBacktest(candles, "APT/USDT", { ...base, postOnlyHalfSpreadPercent: 1.0 });

  // The whole point of the model: resting further from the market must cost
  // fills. If this ever comes back equal, the fill check has been bypassed
  // and the backtest is silently assuming fills again.
  const touchRate = (atTouch.restingFilled ?? 0) / Math.max(1, atTouch.restingPlaced ?? 0);
  const deepRate = (deep.restingFilled ?? 0) / Math.max(1, deep.restingPlaced ?? 0);
  assert(deepRate < touchRate,
    `a bid 1% below the market must fill less than one at the touch (deep=${deepRate.toFixed(2)} vs touch=${touchRate.toFixed(2)})`);
});

test("unfilled resting entries are cancelled, never silently converted into trades", async () => {
  const candles = realCandles();
  // 5% below market: essentially unreachable within the rest window.
  const r = await runBacktest(candles, "APT/USDT", { ...base, postOnlyHalfSpreadPercent: 5.0 });
  assert((r.restingPlaced ?? 0) > 0, "the strategy should still have wanted to enter");
  assert.equal(r.restingFilled ?? 0, 0, "an unreachable bid must never fill");
  assert.equal(r.closedTrades, 0, "and must therefore produce no closed trades");
});

test("every filled resting entry is accounted for — fills never exceed placements", async () => {
  const r = await runBacktest(realCandles(), "APT/USDT", base);
  assert((r.restingFilled ?? 0) <= (r.restingPlaced ?? 0),
    "more fills than orders placed would mean the model is double-counting");
});

test("with post-only off, entries execute immediately and nothing rests", async () => {
  const r = await runBacktest(realCandles(), "APT/USDT", { ...base, usePostOnlyEntries: false });
  assert.equal(r.restingPlaced ?? 0, 0, "taker entries must not go through the resting path");
});
