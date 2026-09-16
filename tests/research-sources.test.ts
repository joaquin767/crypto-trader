// Source adapter tests — specs/daily-catalyst-manual-trading.md §5.3b, AC-6, AC-7.
// No test touches the network: every adapter's `fetch` dependency is a stub reading
// tests/fixtures/research/*.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { AdapterDeps } from "../src/research/http.ts";
import { createBybitFundingAdapter } from "../src/research/sources/bybit-funding.ts";
import { createBybitKlines1dAdapter } from "../src/research/sources/bybit-klines.ts";
import { createBybitOiAdapter } from "../src/research/sources/bybit-oi.ts";
import { createDefillamaStablecoinsAdapter } from "../src/research/sources/defillama-stablecoins.ts";
import {
  createFarsideBtcAdapter, FARSIDE_BTC_CSV_PATH, parseFarsideCsv, parseFarsideHtml,
} from "../src/research/sources/farside.ts";
import { createFearGreedAdapter } from "../src/research/sources/fear-greed.ts";
import { createFredReleaseDatesAdapter } from "../src/research/sources/fred-release-dates.ts";
import { createMacroCalendarManualAdapter, MACRO_CALENDAR_PATH } from "../src/research/sources/macro-calendar-manual.ts";
import { createUnlocksManualAdapter, UNLOCKS_PATH } from "../src/research/sources/unlocks-manual.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "research");
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

const NOW = Date.UTC(2026, 8, 16, 0, 15, 0);

function fakeDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    fetch: (async () => { throw new Error("test forgot to stub fetch"); }) as unknown as typeof fetch,
    now: () => NOW,
    sleep: async () => {},
    readFile: () => { throw new Error("test forgot to stub readFile"); },
    statMtimeMs: () => NOW,
    fileExists: () => false,
    ...overrides,
  };
}

function jsonFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

function rejectingFetch(message: string): typeof fetch {
  return (async () => { throw new Error(message); }) as unknown as typeof fetch;
}

// ── bybit-klines-1d ───────────────────────────────────────────────────────────────────────────

test("bybit-klines-1d: parses a valid response into 5 rows per bar with availableAt = close time", async () => {
  const deps = fakeDeps({ fetch: jsonFetch(readFixture("bybit-kline-response.json")) });
  const adapter = createBybitKlines1dAdapter(deps);
  const snap = await adapter.fetch(NOW, ["BTC/USDT"]);

  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 10); // 2 bars x 5 fields
  const closeRow = snap.rows.find((r) => r.observedFor === 1_700_006_400_000 && r.field === "close");
  assert.equal(closeRow?.value, 50200);
  assert.equal(closeRow?.availableAt, 1_700_006_400_000 + 24 * 60 * 60 * 1000);
});

test("AC-7 (adapter level): a network error yields status unavailable, never throws", async () => {
  const deps = fakeDeps({ fetch: rejectingFetch("DNS failure") });
  const adapter = createBybitKlines1dAdapter(deps);
  const snap = await adapter.fetch(NOW, ["BTC/USDT"]);
  assert.equal(snap.status, "unavailable");
  assert.match(snap.statusDetail, /DNS failure/);
  assert.deepEqual(snap.rows, []);
});

test("bybit-klines-1d: an API error (retCode != 0) is invalid with zero rows", async () => {
  const deps = fakeDeps({ fetch: jsonFetch(JSON.stringify({ retCode: 10001, retMsg: "bad symbol", result: {} })) });
  const adapter = createBybitKlines1dAdapter(deps);
  const snap = await adapter.fetch(NOW, ["BTC/USDT"]);
  assert.equal(snap.status, "invalid");
  assert.deepEqual(snap.rows, []);
  assert.match(snap.statusDetail, /bad symbol/);
});

test("bybit-klines-1d: a second symbol's failure makes the whole snapshot unavailable (never partial rows)", async () => {
  let call = 0;
  const fetchFn = (async () => {
    call++;
    if (call === 1) return new Response(readFixture("bybit-kline-response.json"), { status: 200 });
    throw new Error("second symbol network error");
  }) as unknown as typeof fetch;
  const deps = fakeDeps({ fetch: fetchFn });
  const adapter = createBybitKlines1dAdapter(deps);
  const snap = await adapter.fetch(NOW, ["BTC/USDT", "ETH/USDT"]);
  assert.equal(snap.status, "unavailable");
  assert.deepEqual(snap.rows, []);
});

// ── bybit-funding ────────────────────────────────────────────────────────────────────────────

test("bybit-funding: parses funding rows with availableAt = settlement time", async () => {
  const deps = fakeDeps({ fetch: jsonFetch(readFixture("bybit-funding-response.json")) });
  const adapter = createBybitFundingAdapter(deps);
  const snap = await adapter.fetch(NOW, ["BTC/USDT"]);
  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 3);
  const row = snap.rows.find((r) => r.observedFor === 1_700_006_400_000);
  assert.equal(row?.value, 0.0001);
  assert.equal(row?.availableAt, 1_700_006_400_000);
});

// ── bybit-oi ─────────────────────────────────────────────────────────────────────────────────

test("bybit-oi: parses open-interest rows", async () => {
  const deps = fakeDeps({ fetch: jsonFetch(readFixture("bybit-oi-response.json")) });
  const adapter = createBybitOiAdapter(deps);
  const snap = await adapter.fetch(NOW, ["BTC/USDT"]);
  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 4);
  assert.equal(snap.rows[0]!.field, "oi");
});

// ── fred-release-dates ───────────────────────────────────────────────────────────────────────

test("fred-release-dates: missing FRED_API_KEY yields unavailable with the exact documented reason", async () => {
  const original = process.env["FRED_API_KEY"];
  delete process.env["FRED_API_KEY"];
  try {
    const deps = fakeDeps();
    const adapter = createFredReleaseDatesAdapter(deps);
    const snap = await adapter.fetch(NOW, []);
    assert.equal(snap.status, "unavailable");
    assert.equal(snap.statusDetail, "FRED_API_KEY not set");
  } finally {
    if (original !== undefined) process.env["FRED_API_KEY"] = original;
  }
});

test("fred-release-dates: parses release_dates into rows keyed CPI", async () => {
  process.env["FRED_API_KEY"] = "test-key";
  try {
    const deps = fakeDeps({ fetch: jsonFetch(readFixture("fred-release-dates-response.json")) });
    const adapter = createFredReleaseDatesAdapter(deps);
    const snap = await adapter.fetch(NOW, []);
    assert.equal(snap.status, "ok");
    assert.equal(snap.rows.length, 3);
    assert.ok(snap.rows.every((r) => r.key === "CPI" && r.field === "releaseDate"));
  } finally {
    delete process.env["FRED_API_KEY"];
  }
});

// ── defillama-stablecoins ────────────────────────────────────────────────────────────────────

test("defillama-stablecoins: parses chart points into rows keyed ALL", async () => {
  const deps = fakeDeps({ fetch: jsonFetch(readFixture("defillama-stablecoincharts-response.json")) });
  const adapter = createDefillamaStablecoinsAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 2);
  assert.equal(snap.rows[0]!.key, "ALL");
  assert.equal(snap.rows[0]!.field, "totalSupplyUsd");
});

// ── fear-greed ───────────────────────────────────────────────────────────────────────────────

test("fear-greed: parses the index history", async () => {
  const deps = fakeDeps({ fetch: jsonFetch(readFixture("fear-greed-response.json")) });
  const adapter = createFearGreedAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 2);
  assert.equal(snap.rows[0]!.value, 51);
});

// ── macro-calendar-manual ────────────────────────────────────────────────────────────────────

test("macro-calendar-manual: missing file is unavailable", async () => {
  const deps = fakeDeps({ fileExists: () => false });
  const adapter = createMacroCalendarManualAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "unavailable");
  assert.match(snap.statusDetail, new RegExp(MACRO_CALENDAR_PATH.replace(/[/.]/g, "\\$&")));
});

test("macro-calendar-manual: invalid JSON is invalid", async () => {
  const deps = fakeDeps({ fileExists: () => true, readFile: () => "{ not json" });
  const adapter = createMacroCalendarManualAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "invalid");
});

test("macro-calendar-manual: valid file yields one asOf meta row plus one row per event", async () => {
  const file = { asOf: "2026-09-16", events: [{ type: "FOMC", time: "2026-10-28T18:00:00Z" }] };
  const deps = fakeDeps({ fileExists: () => true, readFile: () => JSON.stringify(file) });
  const adapter = createMacroCalendarManualAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 2);
  assert.ok(snap.rows.some((r) => r.key === "_meta" && r.field === "asOf" && r.value === "2026-09-16"));
  assert.ok(snap.rows.some((r) => r.key === "FOMC" && r.observedFor === Date.parse("2026-10-28T18:00:00Z")));
});

// ── unlocks-manual ───────────────────────────────────────────────────────────────────────────

test("unlocks-manual: valid file yields one asOf meta row plus one row per unlock, keyed by asset", async () => {
  const file = { asOf: "2026-09-16", unlocks: [{ asset: "APT", time: "2026-10-01T00:00:00Z", pctOfCirculating: 1.5 }] };
  const deps = fakeDeps({ fileExists: () => true, readFile: () => JSON.stringify(file) });
  const adapter = createUnlocksManualAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 2);
  const unlockRow = snap.rows.find((r) => r.key === "APT");
  assert.equal(unlockRow?.value, 1.5);
  assert.equal(unlockRow?.observedFor, Date.parse("2026-10-01T00:00:00Z"));
});

test("unlocks-manual: missing file is unavailable", async () => {
  const deps = fakeDeps({ fileExists: () => false });
  const adapter = createUnlocksManualAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "unavailable");
  assert.match(snap.statusDetail, new RegExp(UNLOCKS_PATH.replace(/[/.]/g, "\\$&")));
});

// ── farside ──────────────────────────────────────────────────────────────────────────────────

test("AC-6: a changed Farside header (no Total column) parses to invalid with zero rows", () => {
  const html = readFixture("farside-btc-bad-header.html");
  const result = parseFarsideHtml(html, "BTC", NOW);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.detail, /Total/);
});

test("farside: a valid table parses rows, skips '-' days and the trailing Total summary row", () => {
  const html = readFixture("farside-btc-valid.html");
  const result = parseFarsideHtml(html, "BTC", NOW);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.rows.length, 2); // the "16 Sep 2026" row (all "-") and "Total" row are excluded
  assert.equal(result.rows[0]!.observedFor, Date.UTC(2024, 0, 11));
  assert.equal(result.rows[0]!.value, 655.3 * 1_000_000);
  assert.equal(result.rows[1]!.value, -171.5 * 1_000_000);
  assert.ok(result.rows.every((r) => r.availableAt === NOW));
});

test("farside: HTML fetch unavailable falls back to the manual CSV, availableAt = file mtime", async () => {
  const csvMtime = Date.UTC(2026, 8, 15, 12, 0, 0);
  const deps = fakeDeps({
    fetch: rejectingFetch("blocked"),
    fileExists: (path) => path === FARSIDE_BTC_CSV_PATH,
    readFile: () => readFixture("farside-btc.csv"),
    statMtimeMs: () => csvMtime,
  });
  const adapter = createFarsideBtcAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "ok");
  assert.equal(snap.rows.length, 2);
  assert.ok(snap.rows.every((r) => r.availableAt === csvMtime));
  assert.equal(snap.rows[1]!.value, -30.2 * 1_000_000);
});

test("farside: HTML fetch unavailable and no manual CSV present is unavailable", async () => {
  const deps = fakeDeps({ fetch: rejectingFetch("blocked"), fileExists: () => false });
  const adapter = createFarsideBtcAdapter(deps);
  const snap = await adapter.fetch(NOW, []);
  assert.equal(snap.status, "unavailable");
});

test("parseFarsideCsv rejects a wrong header", () => {
  assert.throws(() => parseFarsideCsv("wrong,header\n2026-09-14,1.0\n", "BTC", NOW), /header/);
});
