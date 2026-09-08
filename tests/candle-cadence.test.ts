import { test } from "node:test";
import assert from "node:assert/strict";
import { recordTick, takeCompletedCandle, seedCandles, clearCandles, getCandles } from "../src/strategy/candles.ts";
import { checkImmediateExit } from "../src/strategy/signals.ts";
import type { Config } from "../src/config.ts";
import type { MarketSnapshot } from "../src/market.ts";

// The live loop used to make every indicator-driven decision once per
// refreshIntervalMs (3s), while runBacktest() replays once per 5m bar. Same
// code, two very different strategies: RSI/Bollinger over 3-second ticks vs
// 5-minute closes, and signalConfirmationTicks=2 meaning 6 seconds live but
// 10 minutes backtested. These pin the two cadences apart.

const config: Config = {
  exchange: "bybit", apiKey: "a", apiSecret: "b", symbols: ["X/USDT"],
  maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 0,
  stopLossPercent: 1, takeProfitPercent: 1, refreshIntervalMs: 3000,
};
const T0 = 1_788_800_000_000;
const snap = (price: number, ts: number): MarketSnapshot =>
  ({ symbol: "X/USDT", price, change24h: 0, volume24h: 1000, timestamp: ts });

test("takeCompletedCandle reports one decision point per closed bar, not per tick", () => {
  clearCandles();
  let decisions = 0;
  const ticks = 250;                       // 250 x 3s = 12.5 minutes
  for (let i = 0; i < ticks; i++) {
    recordTick("X/USDT", 100 + i * 0.001, 1000, T0 + i * 3000);
    if (takeCompletedCandle("X/USDT")) decisions += 1;
  }
  assert(decisions >= 2 && decisions <= 3,
    `12.5 minutes of 3s ticks should yield ~2-3 bar closes, got ${decisions} (ticks: ${ticks})`);
});

test("takeCompletedCandle hands out each bar exactly once", () => {
  clearCandles();
  for (let i = 0; i < 130; i++) recordTick("X/USDT", 100, 1000, T0 + i * 3000);
  const first = takeCompletedCandle("X/USDT");
  assert(first !== null, "a bar should have closed");
  assert.equal(takeCompletedCandle("X/USDT"), null, "the same bar must not be reported twice");
});

test("backfilled history does not trigger a decision on a stale bar", () => {
  clearCandles();
  seedCandles("X/USDT", Array.from({ length: 50 }, (_, i) => ({
    openTime: T0 + i * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 10,
  })));
  assert(getCandles("X/USDT").length === 50, "backfill should populate the window");
  assert.equal(takeCompletedCandle("X/USDT"), null,
    "startup backfill is already in the past — it must not fire an immediate decision");
});

test("stop-loss fires on a 1-second-old position, without waiting for a bar close", () => {
  const exit = checkImmediateExit({ symbol: "X/USDT", entryPrice: 100, openedAt: T0 }, snap(98.5, T0 + 1000), config);
  assert(exit !== null, "a risk-reducing exit must never wait for a candle to close");
  assert(exit.reason.includes("stop-loss"));
});

test("take-profit likewise fires immediately", () => {
  const exit = checkImmediateExit({ symbol: "X/USDT", entryPrice: 100, openedAt: T0 }, snap(101.5, T0 + 1000), config);
  assert(exit !== null);
  assert(exit.reason.includes("take-profit"));
});

test("an in-the-money position inside both barriers is left alone", () => {
  assert.equal(checkImmediateExit({ symbol: "X/USDT", entryPrice: 100, openedAt: T0 }, snap(100.3, T0 + 1000), config), null);
});
