// backfill CLI — specs/daily-catalyst-manual-trading.md §5.10a "History store" bullet list.
//
// Builds `data/history/<sourceId>.json` (gitignored) for every source the daily backtest can
// use, over [--from, --to]. Reuses the exact same parsers the live adapters use (bybit-funding,
// bybit-instruments, defillama-stablecoins, fear-greed, farside) so a row this script produces
// has an identical shape to the one a live snapshot would have produced (buildFeatures runs
// unchanged either way) — only `availableAt` differs, per §10.3's declared backfill lags.
//
// Sources NOT backfilled (A8, §10.3): bybit-oi (no usable free history, still true after Phase 7
// — coinalyze-oi below is the deeper-history OI source oiChange3dPct falls back to instead, per
// §5.16) and unlocks-manual (no free point-in-time history — forwardOnly, X5). Any rule using
// unlocks-manual features is `forwardOnly` and Gate D0 refuses forwardOnly rules outright.
//
// Usage: node --experimental-strip-types scripts/backfill-history.ts --from 2024-01-01 --to
//   2026-09-15 [--history-dir data/history] [--config ./config.json]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/config.ts";
import type { AdapterDeps } from "../src/research/http.ts";
import { defaultAdapterDeps, fetchWithRetryPolicy } from "../src/research/http.ts";
import { fetchKlines } from "../src/journal/market-data.ts";
import { appSymbolToBybit } from "../src/bybit/adapters.ts";
import { acquireBybitSlot } from "../src/research/sources/bybit-shared.ts";
import { parseFundingEntries } from "../src/research/sources/bybit-funding.ts";
import { parseInstrumentsList } from "../src/research/sources/bybit-instruments.ts";
import { parseStablecoinChart } from "../src/research/sources/defillama-stablecoins.ts";
import { parseFearGreedList } from "../src/research/sources/fear-greed.ts";
import { FRED_CPI_RELEASE_ID } from "../src/research/sources/fred-release-dates.ts";
import { parseFarsideCsv, FARSIDE_BTC_CSV_PATH, FARSIDE_ETH_CSV_PATH } from "../src/research/sources/farside.ts";
import { buildCoinalyzeSymbolMap, parseOiHistoryResponse } from "../src/research/sources/coinalyze-oi.ts";
import { acquireCoinalyzeSlot } from "../src/research/sources/coinalyze-shared.ts";
import { cpiReleaseInstantUtcMs } from "../src/research/features.ts";
import type { HistoryFile } from "../src/backtest-daily/history-store.ts";
import { saveHistoryFile } from "../src/backtest-daily/history-store.ts";
import type { SourceId, SourceRow } from "../src/research/types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// FOMC meeting dates are published for the whole following year well in advance; since
// data/manual/fomc-history.json doesn't record each meeting's own announcement date, this is a
// deliberately conservative, documented stand-in (owner may revise): "known" at least 180 days
// (~6 months) before the statement, which is comfortably inside the Fed's typical publication
// lead time without ever claiming knowledge earlier than realistic (P2).
const FOMC_SCHEDULE_KNOWN_LAG_MS = 180 * DAY_MS;
// CPI release dates are a published schedule too (BLS releases each year's calendar months ahead). Marking a
// date as known only at its own release instant made every *upcoming* CPI invisible, so hoursToNextCpi was
// missing on every backtest day. 60 days is conservative and still always reveals the next monthly release.
const CPI_SCHEDULE_KNOWN_LAG_MS = 60 * DAY_MS;
const FOMC_HISTORY_PATH = "data/manual/fomc-history.json";

export interface BackfillArgs {
  from: string;
  to: string;
  historyDir: string;
  configPath: string;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const from = flagValue(argv, "--from");
  const to = flagValue(argv, "--to");
  if (!from || !to) {
    throw new Error("usage: backfill-history.ts --from YYYY-MM-DD --to YYYY-MM-DD [--history-dir data/history] [--config ./config.json]");
  }
  return {
    from,
    to,
    historyDir: flagValue(argv, "--history-dir") ?? "data/history",
    configPath: flagValue(argv, "--config") ?? "./config.json",
  };
}

export interface SourceSummary {
  sourceId: SourceId;
  rows: number;
  coverage: string;
  failure: string | null;
}

/** Rows already on disk for a source, or 0 when there is no readable file yet — used to report what
 *  a failed build kept instead of overwriting (see `build` below). Never throws: an unreadable or
 *  malformed existing file counts as 0 for the summary, and the file itself is still left alone. */
function existingRowCount(historyDir: string, sourceId: SourceId): number {
  try {
    const path = join(historyDir, `${sourceId}.json`);
    if (!existsSync(path)) return 0;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { rows?: unknown };
    return Array.isArray(parsed.rows) ? parsed.rows.length : 0;
  } catch {
    return 0;
  }
}

function summaryOf(sourceId: SourceId, rows: SourceRow[], failure: string | null): SourceSummary {
  if (rows.length === 0) {
    return { sourceId, rows: 0, coverage: "-", failure };
  }
  // Reduce, not Math.min/max(...spread): a multi-year 1h backfill can produce hundreds of
  // thousands of rows, and spreading that many arguments into Math.min/max overflows the call
  // stack (found running the Phase 4b smoke test over the real 2024-01-01..2026-09-15 window).
  let from = rows[0]!.observedFor;
  let to = rows[0]!.observedFor;
  for (const r of rows) {
    if (r.observedFor < from) from = r.observedFor;
    if (r.observedFor > to) to = r.observedFor;
  }
  return { sourceId, rows: rows.length, coverage: `${new Date(from).toISOString().slice(0, 10)}..${new Date(to).toISOString().slice(0, 10)}`, failure };
}

function klineRowsFromFetch(
  bars: readonly { t: number; o: number; h: number; l: number; c: number; v: number }[],
  symbol: string,
  barIntervalMs: number,
): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const bar of bars) {
    const availableAt = bar.t + barIntervalMs;
    rows.push(
      { key: symbol, observedFor: bar.t, availableAt, field: "open", value: bar.o },
      { key: symbol, observedFor: bar.t, availableAt, field: "high", value: bar.h },
      { key: symbol, observedFor: bar.t, availableAt, field: "low", value: bar.l },
      { key: symbol, observedFor: bar.t, availableAt, field: "close", value: bar.c },
      { key: symbol, observedFor: bar.t, availableAt, field: "volume", value: bar.v },
    );
  }
  return rows;
}

// ── per-source builders ─────────────────────────────────────────────────────────────────────

async function buildKlinesSource(
  sourceId: SourceId,
  interval: "D" | "60",
  barIntervalMs: number,
  symbols: readonly string[],
  fromMs: number,
  toMs: number,
  deps: AdapterDeps,
): Promise<SourceRow[] | { failure: string }> {
  const rows: SourceRow[] = [];
  for (const symbol of symbols) {
    const bars = await fetchKlines(symbol, interval, fromMs, toMs, deps);
    if (bars === null) return { failure: `kline fetch failed for ${symbol}` };
    rows.push(...klineRowsFromFetch(bars, symbol, barIntervalMs));
  }
  return rows;
}

const BYBIT_BASE = "https://api.bybit.com";
const FUNDING_PATH = "/v5/market/funding/history";
const FUNDING_PAGE_LIMIT = 200;
const FUNDING_MAX_PAGES = 200; // generous bound for a multi-year window at ~3 settlements/day

async function buildFundingSource(
  symbols: readonly string[],
  fromMs: number,
  deps: AdapterDeps,
): Promise<SourceRow[] | { failure: string }> {
  const rows: SourceRow[] = [];
  for (const symbol of symbols) {
    const bybitSymbol = appSymbolToBybit(symbol);
    const seen = new Set<number>();
    let endTime: number | undefined;
    for (let page = 0; page < FUNDING_MAX_PAGES; page++) {
      const url = `${BYBIT_BASE}${FUNDING_PATH}?category=linear&symbol=${bybitSymbol}&limit=${FUNDING_PAGE_LIMIT}` +
        (endTime !== undefined ? `&endTime=${endTime}` : "");
      await acquireBybitSlot(FUNDING_PATH);
      const http = await fetchWithRetryPolicy(url, undefined, deps);
      if (http.kind === "unavailable") return { failure: `funding fetch failed for ${symbol}: ${http.detail}` };
      let parsed: unknown;
      try {
        parsed = JSON.parse(http.body);
      } catch {
        return { failure: `non-JSON funding response for ${symbol}` };
      }
      const body = parsed as { retCode?: number; retMsg?: string; result?: { list?: unknown[] } };
      if (body.retCode !== 0 || !Array.isArray(body.result?.list)) {
        return { failure: `unexpected funding shape for ${symbol}: retCode=${body.retCode ?? "?"} retMsg="${body.retMsg ?? ""}"` };
      }
      const list = body.result.list;
      if (list.length === 0) break;
      const page1 = parseFundingEntries(list, symbol);
      if (page1.kind === "invalid") return { failure: page1.detail };

      let minTs = Number.POSITIVE_INFINITY;
      for (const { ts, rate } of page1.entries) {
        if (ts < minTs) minTs = ts;
        if (seen.has(ts)) continue;
        seen.add(ts);
        rows.push({ key: symbol, observedFor: ts, availableAt: ts, field: "fundingRate", value: rate });
      }
      if (list.length < FUNDING_PAGE_LIMIT || minTs <= fromMs) break;
      endTime = minTs - 1;
    }
  }
  return rows;
}

const INSTRUMENTS_PATH = "/v5/market/instruments-info";

async function buildInstrumentsSource(symbols: readonly string[], deps: AdapterDeps): Promise<SourceRow[] | { failure: string }> {
  const rows: SourceRow[] = [];
  for (const symbol of symbols) {
    const bybitSymbol = appSymbolToBybit(symbol);
    const url = `${BYBIT_BASE}${INSTRUMENTS_PATH}?category=linear&symbol=${bybitSymbol}`;
    await acquireBybitSlot(INSTRUMENTS_PATH);
    const http = await fetchWithRetryPolicy(url, undefined, deps);
    if (http.kind === "unavailable") return { failure: `instruments fetch failed for ${symbol}: ${http.detail}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(http.body);
    } catch {
      return { failure: `non-JSON instruments-info response for ${symbol}` };
    }
    const body = parsed as { retCode?: number; retMsg?: string; result?: { list?: unknown[] } };
    if (body.retCode !== 0 || !Array.isArray(body.result?.list)) {
      return { failure: `unexpected instruments-info shape for ${symbol}: retCode=${body.retCode ?? "?"} retMsg="${body.retMsg ?? ""}"` };
    }
    // availableAt = 0: A20 backtests use the CURRENT filters for the whole window.
    const parsedList = parseInstrumentsList(body.result.list, symbol, 0);
    if (parsedList.kind === "invalid") return { failure: parsedList.detail };
    rows.push(...parsedList.rows);
  }
  return rows;
}

const DEFILLAMA_URL = "https://stablecoins.llama.fi/stablecoincharts/all";

async function buildStablecoinsSource(deps: AdapterDeps): Promise<SourceRow[] | { failure: string }> {
  const http = await fetchWithRetryPolicy(DEFILLAMA_URL, undefined, deps);
  if (http.kind === "unavailable") return { failure: http.detail };
  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return { failure: "non-JSON response from DefiLlama stablecoincharts" };
  }
  const chart = parseStablecoinChart(parsed);
  if (chart.kind === "invalid") return { failure: chart.detail };
  // §10.3: D+1 at 00:00 UTC.
  return chart.points.map((p): SourceRow => (
    { key: "ALL", observedFor: p.dateSeconds * 1000, availableAt: p.dateSeconds * 1000 + DAY_MS, field: "totalSupplyUsd", value: p.totalUsd }
  ));
}

const FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=0&format=json"; // limit=0: full history

async function buildFearGreedSource(deps: AdapterDeps): Promise<SourceRow[] | { failure: string }> {
  const http = await fetchWithRetryPolicy(FEAR_GREED_URL, undefined, deps);
  if (http.kind === "unavailable") return { failure: http.detail };
  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return { failure: "non-JSON response from alternative.me fng" };
  }
  const list = parseFearGreedList(parsed);
  if (list.kind === "invalid") return { failure: list.detail };
  // §10.3: D at 00:00 UTC + 1h.
  return list.entries.map((e): SourceRow => (
    { key: "BTC", observedFor: e.timestampS * 1000, availableAt: e.timestampS * 1000 + HOUR_MS, field: "fearGreedIndex", value: e.value }
  ));
}

async function buildFredSource(deps: AdapterDeps): Promise<SourceRow[] | { failure: string }> {
  const apiKey = process.env["FRED_API_KEY"];
  if (!apiKey) return { failure: "FRED_API_KEY not set" };
  const url = `https://api.stlouisfed.org/fred/release/dates?release_id=${FRED_CPI_RELEASE_ID}` +
    `&include_release_dates_with_no_data=true&sort_order=desc&file_type=json&api_key=${apiKey}`;
  const http = await fetchWithRetryPolicy(url, undefined, deps);
  if (http.kind === "unavailable") return { failure: http.detail };
  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return { failure: "non-JSON response from FRED release/dates" };
  }
  const body = parsed as { release_dates?: { release_id: number; date: string }[]; error_message?: string };
  if (!Array.isArray(body.release_dates)) {
    return { failure: `unexpected FRED response shape${body.error_message ? `: ${body.error_message}` : ""}` };
  }
  const rows: SourceRow[] = [];
  for (const rd of body.release_dates) {
    const t = Date.parse(`${rd.date}T00:00:00Z`);
    if (!Number.isFinite(t)) return { failure: `unparseable release date "${rd.date}"` };
    // §10.3: scheduled release time (08:30 ET, DST-aware).
    rows.push({ key: "CPI", observedFor: t, availableAt: cpiReleaseInstantUtcMs(rd.date) - CPI_SCHEDULE_KNOWN_LAG_MS, field: "releaseDate", value: rd.date });
  }
  return rows;
}

function buildFomcSource(deps: Pick<AdapterDeps, "fileExists" | "readFile">): SourceRow[] | { failure: string } {
  if (!deps.fileExists(FOMC_HISTORY_PATH)) return { failure: `missing file ${FOMC_HISTORY_PATH}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFile(FOMC_HISTORY_PATH));
  } catch (err) {
    return { failure: `invalid JSON in ${FOMC_HISTORY_PATH}: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { failure: `expected a JSON array in ${FOMC_HISTORY_PATH}` };
  const rows: SourceRow[] = [];
  for (const entry of parsed as { type?: string; time?: string; source?: string }[]) {
    if (entry.type !== "FOMC" || typeof entry.time !== "string") {
      return { failure: `malformed entry in ${FOMC_HISTORY_PATH}: ${JSON.stringify(entry)}` };
    }
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t)) return { failure: `unparseable time "${entry.time}" in ${FOMC_HISTORY_PATH}` };
    rows.push({ key: "FOMC", observedFor: t, availableAt: t - FOMC_SCHEDULE_KNOWN_LAG_MS, field: "eventTime", value: entry.time });
  }
  return rows;
}

const COINALYZE_BASE = "https://api.coinalyze.net/v1";
const COINALYZE_OI_HISTORY_PATH = "/open-interest-history";

/** §5.16: reuses the exact same `parseOiHistoryResponse` the live adapter uses, so `availableAt`
 *  doesn't even differ between live and backfilled rows here (unlike sources whose live
 *  `availableAt` is a conservative `fetchedAt` stand-in) — Coinalyze's `from`/`to` window already
 *  returns genuine historical daily candles. One request covers the whole window (daily
 *  granularity is never deleted, so no paging is needed). */
async function buildCoinalyzeOiSource(
  symbols: readonly string[],
  fromMs: number,
  toMs: number,
  deps: AdapterDeps,
): Promise<SourceRow[] | { failure: string }> {
  const apiKey = process.env["COINALYZE_API_KEY"];
  if (!apiKey) return { failure: "COINALYZE_API_KEY not set" };

  const appSymbolByCoinalyze = buildCoinalyzeSymbolMap(symbols);
  const symbolsCsv = [...appSymbolByCoinalyze.keys()].join(",");
  const fromS = Math.floor(fromMs / 1000);
  const toS = Math.floor(toMs / 1000);
  const url = `${COINALYZE_BASE}${COINALYZE_OI_HISTORY_PATH}?symbols=${encodeURIComponent(symbolsCsv)}` +
    `&interval=daily&from=${fromS}&to=${toS}&api_key=${apiKey}`;

  for (let i = 0; i < symbols.length; i++) await acquireCoinalyzeSlot();

  const http = await fetchWithRetryPolicy(url, undefined, deps);
  if (http.kind === "unavailable") return { failure: http.detail };
  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return { failure: "non-JSON response from Coinalyze open-interest-history" };
  }
  const result = parseOiHistoryResponse(parsed, appSymbolByCoinalyze);
  if (result.kind === "invalid") return { failure: result.detail };
  return result.rows;
}

function buildFarsideSource(csvPath: string, currencyKey: "BTC" | "ETH", deps: Pick<AdapterDeps, "fileExists" | "readFile">): SourceRow[] | { failure: string } {
  if (!deps.fileExists(csvPath)) return { failure: `no manual CSV at ${csvPath}` };
  try {
    const rawRows = parseFarsideCsv(deps.readFile(csvPath), currencyKey, 0);
    // §10.3 / backfill spec: availableAt = D+1 at 12:00 UTC (not file mtime, unlike the live fallback).
    return rawRows.map((r): SourceRow => ({ ...r, availableAt: r.observedFor + DAY_MS + 12 * HOUR_MS }));
  } catch (err) {
    return { failure: `manual CSV ${csvPath} is malformed: ${(err as Error).message}` };
  }
}

// ── orchestration ────────────────────────────────────────────────────────────────────────────

export async function runBackfill(args: BackfillArgs, deps: AdapterDeps): Promise<SourceSummary[]> {
  const config = loadConfig(args.configPath);
  const fromMs = Date.parse(`${args.from}T00:00:00Z`);
  const toMs = Date.parse(`${args.to}T00:00:00Z`) + DAY_MS - 1;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error(`invalid --from/--to ("${args.from}"/"${args.to}")`);
  }
  const builtAt = deps.now();
  const summaries: SourceSummary[] = [];

  async function build(sourceId: SourceId, fn: () => Promise<SourceRow[] | { failure: string }> | SourceRow[] | { failure: string }): Promise<void> {
    const result = await fn();
    const failure = "failure" in result ? result.failure : null;
    if (failure !== null) {
      // A failed source must never overwrite history that was already backfilled: a transient
      // network abort would otherwise replace a multi-year file with `rows: []`, and the D0 gate
      // would then read a real data set as an empty one. The previous file is kept as-is and the
      // failure is reported in the summary (found when a defillama network abort blanked a
      // 3 000-row history in a Phase 7 backfill run).
      const kept = existingRowCount(args.historyDir, sourceId);
      summaries.push({ ...summaryOf(sourceId, [], failure), rows: kept, coverage: kept > 0 ? "kept previous file" : "-" });
      return;
    }
    const rows = result as SourceRow[];
    const file: HistoryFile = { sourceId, builtAt, coverage: { from: fromMs, to: toMs }, rows };
    saveHistoryFile(args.historyDir, file);
    summaries.push(summaryOf(sourceId, rows, null));
  }

  await build("bybit-klines-1d", () => buildKlinesSource("bybit-klines-1d", "D", DAY_MS, config.symbols, fromMs, toMs, deps));
  await build("bybit-klines-1h", () => buildKlinesSource("bybit-klines-1h", "60", HOUR_MS, config.symbols, fromMs, toMs, deps));
  await build("bybit-funding", () => buildFundingSource(config.symbols, fromMs, deps));
  await build("bybit-instruments", () => buildInstrumentsSource(config.symbols, deps));
  await build("defillama-stablecoins", () => buildStablecoinsSource(deps));
  await build("fear-greed", () => buildFearGreedSource(deps));
  await build("fred-release-dates", () => buildFredSource(deps));
  await build("macro-calendar-manual", () => buildFomcSource(deps));
  await build("farside-btc-etf", () => buildFarsideSource(FARSIDE_BTC_CSV_PATH, "BTC", deps));
  await build("farside-eth-etf", () => buildFarsideSource(FARSIDE_ETH_CSV_PATH, "ETH", deps));
  await build("coinalyze-oi", () => buildCoinalyzeOiSource(config.symbols, fromMs, toMs, deps));

  return summaries;
}

function printSummary(summaries: readonly SourceSummary[]): void {
  console.log("source                  rows   coverage                 failure");
  for (const s of summaries) {
    console.log(
      `${s.sourceId.padEnd(23)} ${String(s.rows).padStart(6)}   ${s.coverage.padEnd(24)} ${s.failure ?? ""}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const deps = defaultAdapterDeps();
  const summaries = await runBackfill(args, deps);
  printSummary(summaries);
  // A per-source failure is reported (rows: [], reason in the summary) but never fatal to the
  // run as a whole — other sources still get backfilled, per the file header.
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
