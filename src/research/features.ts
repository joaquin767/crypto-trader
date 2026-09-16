// Feature builder — specs/daily-catalyst-manual-trading.md §5.3 / §5.3a.
//
// Pure: no I/O. Enforces P2 (point-in-time: a row counts only if availableAt <= decisionTime)
// and P1 (fail closed: a source that isn't "ok", or is stale, or is simply absent from the
// snapshot array makes every feature it feeds `{kind:"missing"}` — never a substituted or
// carried-forward value).
//
// SourceRow -> feature mapping notes (Phase 1 design decisions not spelled out verbatim in the
// spec, resolved here):
//  - Daily/hourly klines are stored as 5 SourceRows per bar (one per OHLCV field, same
//    `observedFor`/`availableAt`), since SourceRow carries one value per row; groupKlines()
//    regroups them into Kline objects. A bar counts as "completed" exactly when its
//    availableAt (bar close time) <= decisionTime — the same P2 filter, so no extra logic.
//  - macro-calendar-manual and unlocks-manual staleness is judged by the file's `asOf`, not by
//    `fetchedAt` (§5.3a). Since SourceSnapshot has no dedicated `asOf` field, both adapters
//    emit one extra row `{ key: "_meta", field: "asOf", value: <asOf string> }`; findAsOfMs()
//    reads it back. Every other source's staleness reference is `fetchedAt`.

import type { FeatureName, FeatureValue, FeatureVector, Kline, SourceId, SourceRow, SourceSnapshot } from "./types.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** Default `maxStalenessMs` per source — specs/daily-catalyst-manual-trading.md §5.3b table. */
export const DEFAULT_STALENESS_MS: Readonly<Record<SourceId, number>> = {
  "bybit-klines-1d": 26 * HOUR_MS,
  "bybit-klines-1h": 2 * HOUR_MS,
  "bybit-funding": 9 * HOUR_MS,
  "bybit-oi": 26 * HOUR_MS,
  "bybit-instruments": 7 * DAY_MS, // not a feature source — staleness value kept here for completeness only
  "coinalyze-oi": 26 * HOUR_MS, // Phase 6; no adapter yet, value unused in Phase 1
  "farside-btc-etf": 4 * DAY_MS,
  "farside-eth-etf": 4 * DAY_MS,
  "fred-release-dates": 7 * DAY_MS,
  "macro-calendar-manual": 120 * DAY_MS,
  "defillama-stablecoins": 48 * HOUR_MS,
  "fear-greed": 26 * HOUR_MS,
  "unlocks-manual": 7 * DAY_MS,
};

const META_KEY = "_meta";
const META_ASOF_FIELD = "asOf";

function findAsOfMs(rows: readonly SourceRow[]): number | null {
  const row = rows.find((r) => r.key === META_KEY && r.field === META_ASOF_FIELD);
  if (!row) return null;
  const t = Date.parse(`${row.value}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

interface ResolvedSource {
  ok: boolean;
  reason: string;
  /** Rows already filtered: availableAt <= decisionTime, meta rows excluded. */
  rows: SourceRow[];
}

function resolveSource(
  snapshots: readonly SourceSnapshot[],
  sourceId: SourceId,
  decisionTime: number,
  maxStalenessMs: number,
): ResolvedSource {
  const snap = snapshots.find((s) => s.sourceId === sourceId);
  if (!snap) return { ok: false, reason: `no snapshot for ${sourceId}`, rows: [] };
  if (snap.status !== "ok") return { ok: false, reason: snap.statusDetail || snap.status, rows: [] };

  const asOf = findAsOfMs(snap.rows);
  const reference = asOf ?? snap.fetchedAt;
  if (decisionTime - reference > maxStalenessMs) return { ok: false, reason: "stale", rows: [] };

  const rows = snap.rows.filter((r) => r.key !== META_KEY && r.availableAt <= decisionTime);
  return { ok: true, reason: "", rows };
}

function missing(sourceId: SourceId, reason: string): FeatureValue {
  return { kind: "missing", reason, sourceId };
}

function value(v: number, availableAt: number, sourceId: SourceId): FeatureValue {
  return { kind: "value", value: v, availableAt, sourceId };
}

// ── klines ──────────────────────────────────────────────────────────────────────────────────

/** Regroups per-field kline rows for one symbol into completed Kline bars, newest first. */
function groupKlines(rows: readonly SourceRow[], symbol: string): Kline[] {
  const bars = new Map<number, Partial<Kline> & { t: number }>();
  for (const r of rows) {
    if (r.key !== symbol) continue;
    const bar = bars.get(r.observedFor) ?? { t: r.observedFor };
    if (r.field === "open") bar.o = r.value as number;
    else if (r.field === "high") bar.h = r.value as number;
    else if (r.field === "low") bar.l = r.value as number;
    else if (r.field === "close") bar.c = r.value as number;
    else if (r.field === "volume") bar.v = r.value as number;
    bars.set(r.observedFor, bar);
  }
  const complete: Kline[] = [];
  for (const bar of bars.values()) {
    if (bar.o !== undefined && bar.h !== undefined && bar.l !== undefined && bar.c !== undefined && bar.v !== undefined) {
      complete.push(bar as Kline);
    }
  }
  complete.sort((a, b) => b.t - a.t);
  return complete;
}

function computeClose(bars: readonly Kline[], sourceId: SourceId): FeatureValue {
  if (bars.length < 1) return missing(sourceId, "fewer than 1 completed daily bar");
  const bar0 = bars[0]!;
  return value(bar0.c, bar0.t + DAY_MS, sourceId);
}

function computeReturn1d(bars: readonly Kline[], sourceId: SourceId): FeatureValue {
  if (bars.length < 2) return missing(sourceId, "fewer than 2 completed daily bars");
  const bar0 = bars[0]!, bar1 = bars[1]!;
  return value((bar0.c / bar1.c - 1) * 100, bar0.t + DAY_MS, sourceId);
}

function computeReturn7d(bars: readonly Kline[], sourceId: SourceId): FeatureValue {
  if (bars.length < 8) return missing(sourceId, "fewer than 8 completed daily bars");
  const bar0 = bars[0]!, bar7 = bars[7]!;
  return value((bar0.c / bar7.c - 1) * 100, bar0.t + DAY_MS, sourceId);
}

function computeAtr14d(bars: readonly Kline[], sourceId: SourceId): FeatureValue {
  if (bars.length < 15) return missing(sourceId, "fewer than 15 completed daily bars");
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const bar = bars[i]!;
    const prevClose = bars[i + 1]!.c;
    sum += Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
  }
  return value(sum / 14, bars[0]!.t + DAY_MS, sourceId);
}

function computeRealizedVol7d(bars: readonly Kline[], sourceId: SourceId): FeatureValue {
  if (bars.length < 8) return missing(sourceId, "fewer than 8 completed daily bars");
  const returns: number[] = [];
  for (let i = 0; i < 7; i++) returns.push(Math.log(bars[i]!.c / bars[i + 1]!.c));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return value(Math.sqrt(variance) * Math.sqrt(365) * 100, bars[0]!.t + DAY_MS, sourceId);
}

// ── funding & OI ────────────────────────────────────────────────────────────────────────────

function computeFundingRate8hAvg3d(rows: readonly SourceRow[], symbol: string, decisionTime: number, sourceId: SourceId): FeatureValue {
  const windowStart = decisionTime - 72 * HOUR_MS;
  const inWindow = rows.filter((r) => r.key === symbol && r.field === "fundingRate" && r.observedFor > windowStart && r.observedFor <= decisionTime);
  if (inWindow.length < 3) return missing(sourceId, "fewer than 3 funding settlements in (T-72h, T]");
  const mean = inWindow.reduce((a, r) => a + (r.value as number), 0) / inWindow.length;
  const availableAt = Math.max(...inWindow.map((r) => r.availableAt));
  return value(mean, availableAt, sourceId);
}

function computeFundingRatePercentile90d(rows: readonly SourceRow[], symbol: string, decisionTime: number, sourceId: SourceId): FeatureValue {
  const windowStart = decisionTime - 90 * DAY_MS;
  const inWindow = rows.filter((r) => r.key === symbol && r.field === "fundingRate" && r.observedFor > windowStart && r.observedFor <= decisionTime);
  if (inWindow.length < 90) return missing(sourceId, "fewer than 90 funding settlements in (T-90d, T]");
  let latest = inWindow[0]!;
  for (const r of inWindow) if (r.observedFor > latest.observedFor) latest = r;
  const latestRate = latest.value as number;
  const countLessEq = inWindow.filter((r) => (r.value as number) <= latestRate).length;
  return value((100 * countLessEq) / inWindow.length, latest.availableAt, sourceId);
}

function computeOiChange3dPct(rows: readonly SourceRow[], symbol: string, sourceId: SourceId): FeatureValue {
  const oiRows = rows.filter((r) => r.key === symbol && r.field === "oi").sort((a, b) => b.observedFor - a.observedFor);
  if (oiRows.length < 4) return missing(sourceId, "fewer than 4 OI observations");
  const latest = oiRows[0]!;
  const target = latest.observedFor - 3 * DAY_MS;
  const atOrBefore = oiRows.find((r) => r.observedFor <= target);
  if (!atOrBefore) return missing(sourceId, "no OI observation at or before latest - 3d");
  const pct = (Number(latest.value) / Number(atOrBefore.value) - 1) * 100;
  return value(pct, latest.availableAt, sourceId);
}

// ── market-wide sources ─────────────────────────────────────────────────────────────────────

function latestNRows(rows: readonly SourceRow[], key: string, field: string, n: number): SourceRow[] {
  return rows
    .filter((r) => r.key === key && r.field === field)
    .sort((a, b) => b.observedFor - a.observedFor)
    .slice(0, n);
}

function computeEtfFlow1d(rows: readonly SourceRow[], key: string, sourceId: SourceId): FeatureValue {
  const latest = latestNRows(rows, key, "netFlowUsd", 1);
  if (latest.length < 1) return missing(sourceId, "no ETF flow rows available");
  return value(Number(latest[0]!.value), latest[0]!.availableAt, sourceId);
}

function computeEtfFlow5d(rows: readonly SourceRow[], key: string, sourceId: SourceId): FeatureValue {
  const latest5 = latestNRows(rows, key, "netFlowUsd", 5);
  if (latest5.length < 5) return missing(sourceId, "fewer than 5 ETF flow rows available");
  const sum = latest5.reduce((a, r) => a + Number(r.value), 0);
  const availableAt = Math.max(...latest5.map((r) => r.availableAt));
  return value(sum, availableAt, sourceId);
}

function computeStablecoinSupplyChange7dPct(rows: readonly SourceRow[], sourceId: SourceId): FeatureValue {
  const supplyRows = rows.filter((r) => r.key === "ALL" && r.field === "totalSupplyUsd").sort((a, b) => b.observedFor - a.observedFor);
  if (supplyRows.length < 2) return missing(sourceId, "fewer than 2 stablecoin supply rows");
  const latest = supplyRows[0]!;
  const target = latest.observedFor - 7 * DAY_MS;
  const atOrBefore = supplyRows.find((r) => r.observedFor <= target);
  if (!atOrBefore) return missing(sourceId, "no stablecoin supply row >= 7d before the latest");
  const pct = (Number(latest.value) / Number(atOrBefore.value) - 1) * 100;
  return value(pct, latest.availableAt, sourceId);
}

function computeFearGreed(rows: readonly SourceRow[], sourceId: SourceId): FeatureValue {
  const fgRows = rows.filter((r) => r.field === "fearGreedIndex").sort((a, b) => b.observedFor - a.observedFor);
  if (fgRows.length < 1) return missing(sourceId, "no fear & greed rows");
  const latest = fgRows[0]!;
  return value(Number(latest.value), latest.availableAt, sourceId);
}

function computeHoursToNextFomc(rows: readonly SourceRow[], decisionTime: number, sourceId: SourceId): FeatureValue {
  const events = rows.filter((r) => r.key === "FOMC" && r.field === "eventTime");
  if (events.length === 0) return missing(sourceId, "no FOMC events in the macro calendar");
  const maxEventTime = Math.max(...events.map((r) => r.observedFor));
  if (maxEventTime < decisionTime + 45 * DAY_MS) return missing(sourceId, "macro calendar does not cover decisionTime + 45d");
  const future = events.filter((r) => r.observedFor > decisionTime);
  if (future.length === 0) return missing(sourceId, "no future FOMC event listed");
  let nearest = future[0]!;
  for (const r of future) if (r.observedFor < nearest.observedFor) nearest = r;
  return value((nearest.observedFor - decisionTime) / HOUR_MS, nearest.availableAt, sourceId);
}

/**
 * Resolves a local wall-clock time in `timeZone` to its UTC instant, DST-aware, without a
 * timezone database dependency — Node's Intl already carries IANA tz data. We search whole-hour
 * UTC offsets (US timezones are always a whole-hour offset from UTC) and keep the one whose
 * formatted wall-clock time in `timeZone` matches what was asked for.
 */
export function localTimeToUtcMs(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  for (let offsetHours = -14; offsetHours <= 14; offsetHours++) {
    const guess = Date.UTC(year, month - 1, day, hour - offsetHours, minute);
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    if (get("year") === year && get("month") === month && get("day") === day && get("hour") % 24 === hour && get("minute") === minute) {
      return guess;
    }
  }
  throw new Error(`could not resolve local time ${year}-${month}-${day} ${hour}:${minute} in ${timeZone}`);
}

/** CPI release time: 08:30 America/New_York, DST-aware — §5.3a. `dateIso` is "YYYY-MM-DD". */
export function cpiReleaseInstantUtcMs(dateIso: string): number {
  const parts = dateIso.split("-").map(Number);
  const [year, month, day] = parts as [number, number, number];
  return localTimeToUtcMs(year, month, day, 8, 30, "America/New_York");
}

function computeHoursToNextCpi(rows: readonly SourceRow[], decisionTime: number, sourceId: SourceId): FeatureValue {
  const releases = rows.filter((r) => r.key === "CPI" && r.field === "releaseDate");
  if (releases.length === 0) return missing(sourceId, "no CPI release dates");
  let nearest: { instant: number; availableAt: number } | null = null;
  for (const r of releases) {
    const instant = cpiReleaseInstantUtcMs(String(r.value));
    if (instant > decisionTime && (nearest === null || instant < nearest.instant)) {
      nearest = { instant, availableAt: r.availableAt };
    }
  }
  if (!nearest) return missing(sourceId, "no future CPI release date listed");
  return value((nearest.instant - decisionTime) / HOUR_MS, nearest.availableAt, sourceId);
}

// ── unlocks (per symbol, base asset) ───────────────────────────────────────────────────────

function computeUnlockFeatures(
  rows: readonly SourceRow[],
  baseAsset: string,
  decisionTime: number,
  sourceId: SourceId,
): { days: FeatureValue; pct: FeatureValue } {
  const assetUnlocks = rows.filter((r) => r.key === baseAsset && r.field === "unlock");
  const horizon = decisionTime + 90 * DAY_MS;
  const upcoming = assetUnlocks.filter((r) => r.observedFor > decisionTime && r.observedFor <= horizon);
  if (upcoming.length === 0) {
    // Known absence, not missing (§5.3a): no unlock within 90 days is itself informative.
    return { days: value(999, decisionTime, sourceId), pct: value(0, decisionTime, sourceId) };
  }
  let nearest = upcoming[0]!;
  for (const r of upcoming) if (r.observedFor < nearest.observedFor) nearest = r;
  const days = (nearest.observedFor - decisionTime) / DAY_MS;
  return { days: value(days, nearest.availableAt, sourceId), pct: value(Number(nearest.value), nearest.availableAt, sourceId) };
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────

/** Pure. Any row with availableAt > decisionTime is ignored (P2). A source with status !== "ok"
 *  or fetchedAt older than maxStalenessMs yields { kind: "missing" } for every feature it feeds. */
export function buildFeatures(
  snapshots: readonly SourceSnapshot[],
  symbols: readonly string[],
  decisionTime: number,
  staleness: Readonly<Record<SourceId, number>>,
): FeatureVector[] {
  const klines1d = resolveSource(snapshots, "bybit-klines-1d", decisionTime, staleness["bybit-klines-1d"]);
  const funding = resolveSource(snapshots, "bybit-funding", decisionTime, staleness["bybit-funding"]);
  const oi = resolveSource(snapshots, "bybit-oi", decisionTime, staleness["bybit-oi"]);
  const btcEtf = resolveSource(snapshots, "farside-btc-etf", decisionTime, staleness["farside-btc-etf"]);
  const ethEtf = resolveSource(snapshots, "farside-eth-etf", decisionTime, staleness["farside-eth-etf"]);
  const stablecoins = resolveSource(snapshots, "defillama-stablecoins", decisionTime, staleness["defillama-stablecoins"]);
  const fearGreedSrc = resolveSource(snapshots, "fear-greed", decisionTime, staleness["fear-greed"]);
  const macroCalendar = resolveSource(snapshots, "macro-calendar-manual", decisionTime, staleness["macro-calendar-manual"]);
  const fred = resolveSource(snapshots, "fred-release-dates", decisionTime, staleness["fred-release-dates"]);
  const unlocks = resolveSource(snapshots, "unlocks-manual", decisionTime, staleness["unlocks-manual"]);

  // Market-wide features: computed once, copied into every symbol's vector (§5.3a).
  const btcEtfNetFlowUsd1d = btcEtf.ok ? computeEtfFlow1d(btcEtf.rows, "BTC", "farside-btc-etf") : missing("farside-btc-etf", btcEtf.reason);
  const btcEtfNetFlowUsd5d = btcEtf.ok ? computeEtfFlow5d(btcEtf.rows, "BTC", "farside-btc-etf") : missing("farside-btc-etf", btcEtf.reason);
  const ethEtfNetFlowUsd1d = ethEtf.ok ? computeEtfFlow1d(ethEtf.rows, "ETH", "farside-eth-etf") : missing("farside-eth-etf", ethEtf.reason);
  const stablecoinSupplyChange7dPct = stablecoins.ok
    ? computeStablecoinSupplyChange7dPct(stablecoins.rows, "defillama-stablecoins")
    : missing("defillama-stablecoins", stablecoins.reason);
  const fearGreed = fearGreedSrc.ok ? computeFearGreed(fearGreedSrc.rows, "fear-greed") : missing("fear-greed", fearGreedSrc.reason);
  const hoursToNextFomc = macroCalendar.ok
    ? computeHoursToNextFomc(macroCalendar.rows, decisionTime, "macro-calendar-manual")
    : missing("macro-calendar-manual", macroCalendar.reason);
  const hoursToNextCpi = fred.ok ? computeHoursToNextCpi(fred.rows, decisionTime, "fred-release-dates") : missing("fred-release-dates", fred.reason);

  return symbols.map((symbol): FeatureVector => {
    const baseAsset = symbol.split("/")[0]!;
    const bars = klines1d.ok ? groupKlines(klines1d.rows, symbol) : [];
    const unlockFeatures = unlocks.ok
      ? computeUnlockFeatures(unlocks.rows, baseAsset, decisionTime, "unlocks-manual")
      : { days: missing("unlocks-manual", unlocks.reason), pct: missing("unlocks-manual", unlocks.reason) };

    const features: Record<FeatureName, FeatureValue> = {
      close: klines1d.ok ? computeClose(bars, "bybit-klines-1d") : missing("bybit-klines-1d", klines1d.reason),
      return1d: klines1d.ok ? computeReturn1d(bars, "bybit-klines-1d") : missing("bybit-klines-1d", klines1d.reason),
      return7d: klines1d.ok ? computeReturn7d(bars, "bybit-klines-1d") : missing("bybit-klines-1d", klines1d.reason),
      atr14d: klines1d.ok ? computeAtr14d(bars, "bybit-klines-1d") : missing("bybit-klines-1d", klines1d.reason),
      realizedVol7d: klines1d.ok ? computeRealizedVol7d(bars, "bybit-klines-1d") : missing("bybit-klines-1d", klines1d.reason),
      fundingRate8hAvg3d: funding.ok
        ? computeFundingRate8hAvg3d(funding.rows, symbol, decisionTime, "bybit-funding")
        : missing("bybit-funding", funding.reason),
      fundingRatePercentile90d: funding.ok
        ? computeFundingRatePercentile90d(funding.rows, symbol, decisionTime, "bybit-funding")
        : missing("bybit-funding", funding.reason),
      oiChange3dPct: oi.ok ? computeOiChange3dPct(oi.rows, symbol, "bybit-oi") : missing("bybit-oi", oi.reason),
      btcEtfNetFlowUsd1d,
      btcEtfNetFlowUsd5d,
      ethEtfNetFlowUsd1d,
      stablecoinSupplyChange7dPct,
      fearGreed,
      hoursToNextFomc,
      hoursToNextCpi,
      daysToNextUnlock: unlockFeatures.days,
      nextUnlockPctOfFloat: unlockFeatures.pct,
    };

    return { symbol, decisionTime, features };
  });
}
