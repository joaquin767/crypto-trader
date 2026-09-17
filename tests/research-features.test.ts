// buildFeatures tests — specs/daily-catalyst-manual-trading.md §5.3/§5.3a, AC-1, AC-2, AC-3.
//
// Every formula test hand-derives its expected number from the §5.3a prose (not from calling
// buildFeatures with different inputs), using small synthetic SourceRow fixtures built in this
// file — no network, no snapshot-store, no adapters.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFeatures, cpiReleaseInstantUtcMs, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import type { FeatureValue, SourceRow, SourceSnapshot } from "../src/research/types.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T = Date.UTC(2026, 8, 16, 0, 15, 0); // 2026-09-16T00:15:00Z

function snapshot(overrides: Partial<SourceSnapshot> & Pick<SourceSnapshot, "sourceId" | "rows">): SourceSnapshot {
  return { fetchedAt: T, status: "ok", statusDetail: "", sha256: "", ...overrides };
}

// ── AC-1, AC-2, AC-3 ─────────────────────────────────────────────────────────────────────────

test("AC-1: a row with availableAt = T+1 is ignored, so the dependent feature is missing at decisionTime T", () => {
  const rows: SourceRow[] = [{ key: "BTC", observedFor: T, availableAt: T + 1, field: "fearGreedIndex", value: 50 }];
  const snapshots = [snapshot({ sourceId: "fear-greed", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  assert.equal(fv!.features.fearGreed.kind, "missing");
});

test("AC-2: a source snapshot with status unavailable makes every feature it feeds missing, reason containing statusDetail", () => {
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", status: "unavailable", statusDetail: "DNS failure contacting bybit", rows: [] })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  for (const name of ["close", "return1d", "return7d", "atr14d", "realizedVol7d"] as const) {
    const f = fv!.features[name];
    assert.equal(f.kind, "missing");
    if (f.kind === "missing") assert.match(f.reason, /DNS failure contacting bybit/);
  }
});

test("AC-3: a snapshot fetched before maxStalenessMs's cutoff yields missing with reason 'stale'", () => {
  const rows: SourceRow[] = [{ key: "BTC", observedFor: T - 30 * HOUR, availableAt: T - 30 * HOUR, field: "fearGreedIndex", value: 50 }];
  const snapshots = [snapshot({ sourceId: "fear-greed", fetchedAt: T - 30 * HOUR, rows })]; // maxStalenessMs for fear-greed is 26h
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  assert.equal(fv!.features.fearGreed.kind, "missing");
  if (fv!.features.fearGreed.kind === "missing") assert.equal(fv!.features.fearGreed.reason, "stale");
});

// ── daily-kline-derived features ────────────────────────────────────────────────────────────

function buildDailyKlineRows(symbol: string, closesNewestFirst: readonly number[], t0: number): SourceRow[] {
  const rows: SourceRow[] = [];
  closesNewestFirst.forEach((c, i) => {
    const t = t0 - i * DAY;
    const availableAt = t + DAY;
    const h = c + 5, l = c - 5;
    rows.push(
      { key: symbol, observedFor: t, availableAt, field: "open", value: c },
      { key: symbol, observedFor: t, availableAt, field: "high", value: h },
      { key: symbol, observedFor: t, availableAt, field: "low", value: l },
      { key: symbol, observedFor: t, availableAt, field: "close", value: c },
      { key: symbol, observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  });
  return rows;
}

// C_i = 100 - i for i=0..15 (i=0 newest); a clean +1/day uptrend with a constant 10-wide
// high/low range around each close (so true range never has to consider the +-5 wick).
const CLOSES = Array.from({ length: 16 }, (_, i) => 100 - i);
const T0 = T - DAY; // bar0 (i=0) closes exactly at T

function expectedAtr14d(closes: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const c = closes[i]!, prevClose = closes[i + 1]!;
    const h = c + 5, l = c - 5;
    sum += Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  }
  return sum / 14;
}

function expectedRealizedVol7d(closes: readonly number[]): number {
  const returns: number[] = [];
  for (let i = 0; i < 7; i++) returns.push(Math.log(closes[i]! / closes[i + 1]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

test("§5.3a close: latest completed bar's close, availableAt = its close time", () => {
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows: buildDailyKlineRows("BTC/USDT", CLOSES, T0) })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.close;
  assert.equal(f.kind, "value");
  if (f.kind === "value") { assert.equal(f.value, 100); assert.equal(f.availableAt, T); }
});

test("§5.3a return1d: (close_0/close_1 - 1) x 100", () => {
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows: buildDailyKlineRows("BTC/USDT", CLOSES, T0) })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.return1d;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - (100 / 99 - 1) * 100) < 1e-9);
});

test("§5.3a return7d: (close_0/close_7 - 1) x 100", () => {
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows: buildDailyKlineRows("BTC/USDT", CLOSES, T0) })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.return7d;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - (100 / 93 - 1) * 100) < 1e-9);
});

test("§5.3a atr14d: mean true range over the 14 latest completed bars", () => {
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows: buildDailyKlineRows("BTC/USDT", CLOSES, T0) })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.atr14d;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - expectedAtr14d(CLOSES)) < 1e-9);
});

test("§5.3a atr14d: missing with only 14 completed bars (needs 15)", () => {
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows: buildDailyKlineRows("BTC/USDT", CLOSES.slice(0, 14), T0) })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  assert.equal(fv!.features.atr14d.kind, "missing");
});

test("§5.3a realizedVol7d: sample stdev of 7 daily log returns x sqrt(365) x 100", () => {
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows: buildDailyKlineRows("BTC/USDT", CLOSES, T0) })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.realizedVol7d;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - expectedRealizedVol7d(CLOSES)) < 1e-9);
});

// ── funding ──────────────────────────────────────────────────────────────────────────────────

test("§5.3a fundingRate8hAvg3d: mean of settlements in (T-72h, T]", () => {
  const rows: SourceRow[] = [
    { key: "BTC/USDT", observedFor: T - 1 * HOUR, availableAt: T - 1 * HOUR, field: "fundingRate", value: 0.0001 },
    { key: "BTC/USDT", observedFor: T - 9 * HOUR, availableAt: T - 9 * HOUR, field: "fundingRate", value: 0.0002 },
    { key: "BTC/USDT", observedFor: T - 17 * HOUR, availableAt: T - 17 * HOUR, field: "fundingRate", value: 0.0003 },
  ];
  const snapshots = [snapshot({ sourceId: "bybit-funding", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.fundingRate8hAvg3d;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - 0.0002) < 1e-12);
});

test("§5.3a fundingRatePercentile90d: 100 x count(rate <= latest) / count, over >=90 rows", () => {
  const rows: SourceRow[] = Array.from({ length: 90 }, (_, idx) => {
    const i = idx + 1; // 1..90, i=90 is the latest settlement in time
    // Daily spacing so the oldest row (i=1, T-89d) sits within 24h of the 90d window start
    // (T-90d) — satisfies the §5.3a contiguity requirement for this feature.
    return {
      key: "BTC/USDT",
      observedFor: T - (90 - i) * DAY,
      availableAt: T - (90 - i) * DAY,
      field: "fundingRate",
      value: 91 - i, // latest (i=90) has the smallest value (1) — only itself is <= itself
    } satisfies SourceRow;
  });
  const snapshots = [snapshot({ sourceId: "bybit-funding", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.fundingRatePercentile90d;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - (100 / 90)) < 1e-9);
});

test("§5.3a fundingRatePercentile90d: missing with fewer than 90 rows", () => {
  const rows: SourceRow[] = Array.from({ length: 5 }, (_, i) => ({
    key: "BTC/USDT", observedFor: T - i * HOUR, availableAt: T - i * HOUR, field: "fundingRate", value: 0.0001,
  }));
  const snapshots = [snapshot({ sourceId: "bybit-funding", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  assert.equal(fv!.features.fundingRatePercentile90d.kind, "missing");
});

// ── OI ───────────────────────────────────────────────────────────────────────────────────────

test("§5.3a oiChange3dPct: (oi_latest / oi_at_or_before(latest-3d) - 1) x 100", () => {
  const rows: SourceRow[] = [
    { key: "BTC/USDT", observedFor: T, availableAt: T, field: "oi", value: 110 },
    { key: "BTC/USDT", observedFor: T - 1 * DAY, availableAt: T - 1 * DAY, field: "oi", value: 105 },
    { key: "BTC/USDT", observedFor: T - 2 * DAY, availableAt: T - 2 * DAY, field: "oi", value: 102 },
    { key: "BTC/USDT", observedFor: T - 3 * DAY, availableAt: T - 3 * DAY, field: "oi", value: 100 },
    { key: "BTC/USDT", observedFor: T - 4 * DAY, availableAt: T - 4 * DAY, field: "oi", value: 95 },
  ];
  const snapshots = [snapshot({ sourceId: "bybit-oi", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.oiChange3dPct;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - 10) < 1e-9); // (110/100 - 1) * 100
});

// ── market-wide: ETF flows, stablecoins, fear & greed ───────────────────────────────────────

test("§5.3a btcEtfNetFlowUsd1d/5d: latest day and sum of latest 5 days, copied to every symbol", () => {
  const rows: SourceRow[] = [10, 20, 30, 40, 50].map((v, i) => ({
    key: "BTC", observedFor: T - (4 - i) * DAY, availableAt: T, field: "netFlowUsd", value: v,
  }));
  const snapshots = [snapshot({ sourceId: "farside-btc-etf", rows })];
  const [btc, eth] = buildFeatures(snapshots, ["BTC/USDT", "ETH/USDT"], T, DEFAULT_STALENESS_MS);
  for (const fv of [btc!, eth!]) {
    const f1 = fv.features.btcEtfNetFlowUsd1d, f5 = fv.features.btcEtfNetFlowUsd5d;
    assert.equal(f1.kind, "value");
    assert.equal(f5.kind, "value");
    if (f1.kind === "value") assert.equal(f1.value, 50);
    if (f5.kind === "value") assert.equal(f5.value, 150);
  }
});

test("§5.3a stablecoinSupplyChange7dPct: (latest / at_or_before(latest-7d) - 1) x 100", () => {
  const rows: SourceRow[] = [
    { key: "ALL", observedFor: T, availableAt: T, field: "totalSupplyUsd", value: 110 },
    { key: "ALL", observedFor: T - 7 * DAY, availableAt: T, field: "totalSupplyUsd", value: 100 },
  ];
  const snapshots = [snapshot({ sourceId: "defillama-stablecoins", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.stablecoinSupplyChange7dPct;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.ok(Math.abs(f.value - 10) < 1e-9);
});

test("§5.3a fearGreed: latest index value", () => {
  const rows: SourceRow[] = [{ key: "BTC", observedFor: T, availableAt: T, field: "fearGreedIndex", value: 42 }];
  const snapshots = [snapshot({ sourceId: "fear-greed", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.fearGreed;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.equal(f.value, 42);
});

// ── macro calendar / FOMC ────────────────────────────────────────────────────────────────────

test("§5.3a hoursToNextFomc: hours to the first future event, when the calendar covers T+45d", () => {
  const rows: SourceRow[] = [
    { key: "_meta", observedFor: T, availableAt: T, field: "asOf", value: "2026-09-16" },
    { key: "FOMC", observedFor: T + 10 * DAY, availableAt: T, field: "eventTime", value: "x" },
    { key: "FOMC", observedFor: T + 50 * DAY, availableAt: T, field: "eventTime", value: "x" },
  ];
  const snapshots = [snapshot({ sourceId: "macro-calendar-manual", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.hoursToNextFomc;
  assert.equal(f.kind, "value");
  if (f.kind === "value") assert.equal(f.value, 240); // 10 days
});

test("§5.3a hoursToNextFomc: missing when the calendar does not reach T+45d", () => {
  const rows: SourceRow[] = [
    { key: "_meta", observedFor: T, availableAt: T, field: "asOf", value: "2026-09-16" },
    { key: "FOMC", observedFor: T + 10 * DAY, availableAt: T, field: "eventTime", value: "x" },
  ];
  const snapshots = [snapshot({ sourceId: "macro-calendar-manual", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  assert.equal(fv!.features.hoursToNextFomc.kind, "missing");
});

// ── CPI / DST ────────────────────────────────────────────────────────────────────────────────

test("cpiReleaseInstantUtcMs: summer date is 08:30 EDT (UTC-4)", () => {
  assert.equal(cpiReleaseInstantUtcMs("2026-07-15"), Date.UTC(2026, 6, 15, 12, 30, 0));
});

test("cpiReleaseInstantUtcMs: winter date is 08:30 EST (UTC-5)", () => {
  assert.equal(cpiReleaseInstantUtcMs("2026-01-15"), Date.UTC(2026, 0, 15, 13, 30, 0));
});

test("§5.3a hoursToNextCpi: hours to the next 08:30 America/New_York release", () => {
  const rows: SourceRow[] = [
    { key: "CPI", observedFor: Date.UTC(2026, 7, 12), availableAt: T, field: "releaseDate", value: "2026-08-12" }, // past
    { key: "CPI", observedFor: Date.UTC(2026, 9, 13), availableAt: T, field: "releaseDate", value: "2026-10-13" }, // future
  ];
  const snapshots = [snapshot({ sourceId: "fred-release-dates", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.hoursToNextCpi;
  assert.equal(f.kind, "value");
  const expectedInstant = cpiReleaseInstantUtcMs("2026-10-13");
  if (f.kind === "value") assert.ok(Math.abs(f.value - (expectedInstant - T) / HOUR) < 1e-9);
});

// ── unlocks ──────────────────────────────────────────────────────────────────────────────────

test("§5.3a daysToNextUnlock/nextUnlockPctOfFloat: 999/0 when no unlock within 90 days", () => {
  const rows: SourceRow[] = [{ key: "_meta", observedFor: T, availableAt: T, field: "asOf", value: "2026-09-16" }];
  const snapshots = [snapshot({ sourceId: "unlocks-manual", rows })];
  const [fv] = buildFeatures(snapshots, ["APT/USDT"], T, DEFAULT_STALENESS_MS);
  const days = fv!.features.daysToNextUnlock, pct = fv!.features.nextUnlockPctOfFloat;
  assert.equal(days.kind, "value");
  assert.equal(pct.kind, "value");
  if (days.kind === "value") assert.equal(days.value, 999);
  if (pct.kind === "value") assert.equal(pct.value, 0);
});

test("§5.3a daysToNextUnlock/nextUnlockPctOfFloat: nearest upcoming unlock for the symbol's base asset", () => {
  const rows: SourceRow[] = [
    { key: "_meta", observedFor: T, availableAt: T, field: "asOf", value: "2026-09-16" },
    { key: "APT", observedFor: T + 30 * DAY, availableAt: T, field: "unlock", value: 2.5 },
    { key: "SOL", observedFor: T + 5 * DAY, availableAt: T, field: "unlock", value: 9.9 }, // different asset, must not leak
  ];
  const snapshots = [snapshot({ sourceId: "unlocks-manual", rows })];
  const [fv] = buildFeatures(snapshots, ["APT/USDT"], T, DEFAULT_STALENESS_MS);
  const days = fv!.features.daysToNextUnlock, pct = fv!.features.nextUnlockPctOfFloat;
  assert.equal(days.kind, "value");
  assert.equal(pct.kind, "value");
  if (days.kind === "value") assert.equal(days.value, 30);
  if (pct.kind === "value") assert.equal(pct.value, 2.5);
});

// ── AC-95: contiguity ────────────────────────────────────────────────────────────────────────

function buildDailyKlineRowsWithGap(
  symbol: string,
  closesNewestFirst: readonly number[],
  t0: number,
  gapAfterIndex: number,
): SourceRow[] {
  const rows: SourceRow[] = [];
  closesNewestFirst.forEach((c, i) => {
    const extra = i > gapAfterIndex ? DAY : 0; // everything older than the gap is pushed back one more day
    const t = t0 - i * DAY - extra;
    const availableAt = t + DAY;
    const h = c + 5, l = c - 5;
    rows.push(
      { key: symbol, observedFor: t, availableAt, field: "open", value: c },
      { key: symbol, observedFor: t, availableAt, field: "high", value: h },
      { key: symbol, observedFor: t, availableAt, field: "low", value: l },
      { key: symbol, observedFor: t, availableAt, field: "close", value: c },
      { key: symbol, observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  });
  return rows;
}

test("AC-95: atr14d missing (gap in daily bars) with one missing day inside the last 15 bars", () => {
  const closes = CLOSES.slice(0, 15); // exactly the 15 bars atr14d needs
  const rows = buildDailyKlineRowsWithGap("BTC/USDT", closes, T0, 7); // gap between bar 7 and bar 8
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.atr14d;
  assert.equal(f.kind, "missing");
  if (f.kind === "missing") assert.equal(f.reason, "gap in daily bars");
});

test("AC-95: atr14d is a value when the same 15 bars have no gap", () => {
  const closes = CLOSES.slice(0, 15);
  const rows = buildDailyKlineRows("BTC/USDT", closes, T0);
  const snapshots = [snapshot({ sourceId: "bybit-klines-1d", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  assert.equal(fv!.features.atr14d.kind, "value");
});

test("AC-95: stablecoinSupplyChange7dPct missing (gap) when the comparison row is 30h older than its target", () => {
  const rows: SourceRow[] = [
    { key: "ALL", observedFor: T, availableAt: T, field: "totalSupplyUsd", value: 110 },
    // target = T - 7d; this row sits 30h before the target, exceeding the 24h contiguity tolerance.
    { key: "ALL", observedFor: T - 7 * DAY - 30 * HOUR, availableAt: T, field: "totalSupplyUsd", value: 100 },
  ];
  const snapshots = [snapshot({ sourceId: "defillama-stablecoins", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.stablecoinSupplyChange7dPct;
  assert.equal(f.kind, "missing");
  if (f.kind === "missing") assert.equal(f.reason, "gap");
});

test("AC-95: btcEtfNetFlowUsd5d missing (gap) when the 5 rows span 10 calendar days", () => {
  const offsets = [10, 7, 5, 2, 0]; // days back from T — span is 10 days, over the 9-day tolerance
  const rows: SourceRow[] = offsets.map((d, i) => ({
    key: "BTC", observedFor: T - d * DAY, availableAt: T, field: "netFlowUsd", value: 10 * (i + 1),
  }));
  const snapshots = [snapshot({ sourceId: "farside-btc-etf", rows })];
  const [fv] = buildFeatures(snapshots, ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const f = fv!.features.btcEtfNetFlowUsd5d;
  assert.equal(f.kind, "missing");
  if (f.kind === "missing") assert.equal(f.reason, "gap");
});

test("every one of the 17 feature names is always produced (value or missing) with no snapshots at all", () => {
  const [fv] = buildFeatures([], ["BTC/USDT"], T, DEFAULT_STALENESS_MS);
  const names = Object.keys(fv!.features);
  assert.equal(names.length, 17);
  assert.ok((Object.values(fv!.features) as FeatureValue[]).every((f) => f.kind === "missing"));
});
