// Public market data tests — specs/daily-catalyst-manual-trading.md §5.14, AC-71.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchKlines, splitFormingCandle } from "../src/journal/market-data.ts";
import type { Kline } from "../src/research/types.ts";

const HOUR_MS = 60 * 60 * 1000;

function bybitBody(bars: readonly Kline[]): string {
  const list = bars.map((b) => [String(b.t), String(b.o), String(b.h), String(b.l), String(b.c), String(b.v)]);
  return JSON.stringify({ retCode: 0, retMsg: "OK", result: { list } });
}

/** A fake Bybit kline endpoint: serves bars within [start,end] (inclusive), newest-first,
 *  capped at `perPage`, mirroring the real API's pagination shape. */
function fakePagedFetch(allBars: readonly Kline[], perPage: number): { fetch: typeof globalThis.fetch; calls: () => number } {
  let calls = 0;
  const fetchFn = (async (url: string | URL) => {
    calls++;
    const u = new URL(String(url));
    const start = Number(u.searchParams.get("start"));
    const end = Number(u.searchParams.get("end"));
    const inRange = allBars.filter((b) => b.t >= start && b.t <= end).slice().sort((a, b) => b.t - a.t);
    const page = inRange.slice(0, perPage);
    return new Response(bybitBody(page), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchFn, calls: () => calls };
}

const noopSleep = () => Promise.resolve();

test("AC-71: fetchKlines pages backwards over 400 hourly bars served ≤200 per page, returns 400 ascending deduped bars", async () => {
  const bars: Kline[] = Array.from({ length: 400 }, (_, i) => ({ t: i * HOUR_MS, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const { fetch, calls } = fakePagedFetch(bars, 200);
  const result = await fetchKlines("BTC/USDT", "60", 0, 399 * HOUR_MS, { fetch, sleep: noopSleep });
  assert.ok(result !== null);
  assert.equal(result!.length, 400);
  for (let i = 0; i < result!.length; i++) assert.equal(result![i]!.t, i * HOUR_MS);
  for (let i = 1; i < result!.length; i++) assert.ok(result![i]!.t > result![i - 1]!.t);
  assert.equal(calls(), 2); // 400 bars / 200 per page
});

test("AC-71: a network error on any page returns null, never a partial series", async () => {
  const failingFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof globalThis.fetch;
  const result = await fetchKlines("BTC/USDT", "60", 0, 399 * HOUR_MS, { fetch: failingFetch, sleep: noopSleep });
  assert.equal(result, null);
});

test("AC-71: a malformed bar on any page returns null, never a partial series", async () => {
  const malformedFetch = (async () =>
    new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: [["not", "enough"]] } }), { status: 200 })
  ) as unknown as typeof globalThis.fetch;
  const result = await fetchKlines("BTC/USDT", "60", 0, 10 * HOUR_MS, { fetch: malformedFetch, sleep: noopSleep });
  assert.equal(result, null);
});

test("AC-71: an unexpected retCode/shape returns null", async () => {
  const badShapeFetch = (async () =>
    new Response(JSON.stringify({ retCode: 10001, retMsg: "params error" }), { status: 200 })
  ) as unknown as typeof globalThis.fetch;
  const result = await fetchKlines("BTC/USDT", "60", 0, 10 * HOUR_MS, { fetch: badShapeFetch, sleep: noopSleep });
  assert.equal(result, null);
});

test("fetchKlines dedupes bars seen on overlapping pages", async () => {
  const bars: Kline[] = Array.from({ length: 50 }, (_, i) => ({ t: i * HOUR_MS, o: 1, h: 1, l: 1, c: i, v: 1 }));
  const { fetch } = fakePagedFetch(bars, 30); // 30 then 20, overlapping window at the boundary
  const result = await fetchKlines("BTC/USDT", "60", 0, 49 * HOUR_MS, { fetch, sleep: noopSleep });
  assert.equal(result!.length, 50);
  const seen = new Set(result!.map((k) => k.t));
  assert.equal(seen.size, 50);
});

// ── splitFormingCandle ──────────────────────────────────────────────────────────────────────────

test("splitFormingCandle splits the newest bar off when its close time is still in the future", () => {
  const candles: Kline[] = [
    { t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: HOUR_MS, o: 1, h: 1, l: 1, c: 1, v: 1 },
  ];
  const now = HOUR_MS + 30 * 60_000; // 30 minutes into the second bar — not closed yet
  const { candles: closed, formingCandle } = splitFormingCandle(candles, "60", now);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.t, 0);
  assert.equal(formingCandle?.t, HOUR_MS);
});

test("splitFormingCandle leaves candles untouched when the newest bar has already closed", () => {
  const candles: Kline[] = [
    { t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: HOUR_MS, o: 1, h: 1, l: 1, c: 1, v: 1 },
  ];
  const now = 2 * HOUR_MS + 1;
  const { candles: closed, formingCandle } = splitFormingCandle(candles, "60", now);
  assert.equal(closed.length, 2);
  assert.equal(formingCandle, null);
});

test("splitFormingCandle on an empty array returns no forming candle", () => {
  const { candles, formingCandle } = splitFormingCandle([], "60", 0);
  assert.deepEqual(candles, []);
  assert.equal(formingCandle, null);
});
