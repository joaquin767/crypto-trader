// coinalyze-oi adapter — specs/daily-catalyst-manual-trading.md §5.16 "Phase 7 hardening".
//
// GET https://api.coinalyze.net/v1/open-interest-history?symbols=<coinalyze symbols>&interval=daily
//   &from=<unix s>&to=<unix s>&api_key=<COINALYZE_API_KEY>
//
// Deeper-history OI source: bybit-oi.ts's own history is short (limit=10), so oiChange3dPct falls
// back to this source when bybit-oi's rows are insufficient (src/research/features.ts). Missing
// COINALYZE_API_KEY -> snapshot "unavailable" (never a crash); the key travels as the `api_key`
// query param, which already matches http.ts's SECRET_QUERY_PARAM regex, so redactUrl/the
// network-error path redact it with no extra work here (same as FRED's own api_key).

import { appSymbolToBybit } from "../../bybit/adapters.ts";
import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy, redactUrl } from "../http.ts";
import type { SourceAdapter, SourceRow } from "../types.ts";
import { invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";
import { acquireCoinalyzeSlot } from "./coinalyze-shared.ts";

export const COINALYZE_BASE = "https://api.coinalyze.net/v1";
export const OI_HISTORY_PATH = "/open-interest-history";

/** Coinalyze's exchange code for Bybit — verified 2026-09-16 by loading
 *  https://coinalyze.net/markets/?exchange=6 and confirming the page renders as "Bybit Live Prices
 *  and Charts" (the API's own /exchanges endpoint requires a key, so this is the only
 *  unauthenticated way to confirm it). */
export const COINALYZE_BYBIT_EXCHANGE_CODE = "6";

const LOOKBACK_DAYS = 10; // matches bybit-oi's own limit=10 — comfortably above oiChange3dPct's 4-row minimum
/** §5.16: a daily candle's own close is `observedFor + 24h`; Coinalyze publishes no settlement lag
 *  for the daily granularity, so this reuses the existing "+1h cushion" convention already used
 *  for fear-greed (§10.3: "D at 00:00 UTC + 1h") rather than inventing a new unverified number. */
const AVAILABLE_AT_LAG_MS = 25 * 60 * 60 * 1000; // 24h (day) + 1h (cushion)

/** "BTC/USDT" -> "BTCUSDT.6". Verified live against `GET /v1/future-markets` with a real key
 *  (2026-09-17): Bybit's USDT perpetuals are `BTCUSDT.6` / `ETHUSDT.6` (`is_perpetual: true`).
 *  There is NO `_PERP` infix for this exchange — the first implementation assumed one from another
 *  exchange's docs example and the live call returned an empty array with HTTP 200, which is why
 *  §5.16's AC-133 (live smoke) exists. Every Coinalyze symbol names one exchange, so this always
 *  names Bybit specifically — the same venue bybit-oi.ts measures. */
export function coinalyzeSymbolFor(appSymbol: string): string {
  return `${appSymbolToBybit(appSymbol)}.${COINALYZE_BYBIT_EXCHANGE_CODE}`;
}

/** coinalyze symbol -> app symbol. Shared between the live adapter and
 *  scripts/backfill-history.ts so both build the exact same request and the exact same reverse
 *  lookup for parseOiHistoryResponse. */
export function buildCoinalyzeSymbolMap(symbols: readonly string[]): Map<string, string> {
  return new Map(symbols.map((s) => [coinalyzeSymbolFor(s), s]));
}

interface CoinalyzeCandle {
  t?: unknown; // beginning of the interval, UNIX seconds
  c?: unknown; // OI at the end of the interval
}

interface CoinalyzeOiHistoryEntry {
  symbol?: unknown;
  history?: unknown;
}

/** Pure parser reused verbatim by the live adapter and scripts/backfill-history.ts (§5.16). One
 *  row per returned daily candle, shaped like bybit-oi's rows so computeOiChange3dPct can consume
 *  either source unchanged. */
export function parseOiHistoryResponse(
  parsed: unknown,
  appSymbolByCoinalyze: ReadonlyMap<string, string>,
): { kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string } {
  if (!Array.isArray(parsed)) {
    return { kind: "invalid", detail: "expected a JSON array from Coinalyze open-interest-history" };
  }
  const rows: SourceRow[] = [];
  for (const raw of parsed as CoinalyzeOiHistoryEntry[]) {
    const coinalyzeSymbol = raw.symbol;
    const appSymbol = typeof coinalyzeSymbol === "string" ? appSymbolByCoinalyze.get(coinalyzeSymbol) : undefined;
    if (!appSymbol || !Array.isArray(raw.history)) {
      return { kind: "invalid", detail: `unexpected open-interest-history entry: ${JSON.stringify(raw).slice(0, 200)}` };
    }
    for (const candle of raw.history as CoinalyzeCandle[]) {
      const t = Number(candle.t);
      const c = Number(candle.c);
      if (!Number.isFinite(t) || !Number.isFinite(c)) {
        return { kind: "invalid", detail: `non-numeric OI candle for ${coinalyzeSymbol}: ${JSON.stringify(candle)}` };
      }
      const observedFor = t * 1000;
      rows.push({ key: appSymbol, observedFor, availableAt: observedFor + AVAILABLE_AT_LAG_MS, field: "oi", value: c });
    }
  }
  return { kind: "ok", rows };
}

export function createCoinalyzeOiAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "coinalyze-oi",
    maxStalenessMs: 26 * 60 * 60 * 1000,
    async fetch(decisionTime: number, symbols: readonly string[]) {
      const fetchedAt = deps.now();
      const apiKey = process.env["COINALYZE_API_KEY"];
      if (!apiKey) return unavailableSnapshot("coinalyze-oi", fetchedAt, "COINALYZE_API_KEY not set");

      const appSymbolByCoinalyze = buildCoinalyzeSymbolMap(symbols);
      const symbolsCsv = [...appSymbolByCoinalyze.keys()].join(",");
      const toS = Math.floor(decisionTime / 1000);
      const fromS = toS - LOOKBACK_DAYS * 24 * 60 * 60;
      const url = `${COINALYZE_BASE}${OI_HISTORY_PATH}?symbols=${encodeURIComponent(symbolsCsv)}` +
        `&interval=daily&from=${fromS}&to=${toS}&api_key=${apiKey}`;

      // §10.2: 40 req/min, one credit per symbol named in the request — acquire before the single
      // HTTP call so the credit accounting matches Coinalyze's, not the HTTP call count.
      for (let i = 0; i < symbols.length; i++) await acquireCoinalyzeSlot();

      const http = await fetchWithRetryPolicy(url, undefined, deps);
      if (http.kind === "unavailable") return unavailableSnapshot("coinalyze-oi", fetchedAt, http.detail);

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(http.body);
      } catch {
        return invalidSnapshot("coinalyze-oi", fetchedAt, `non-JSON open-interest-history response from ${redactUrl(url)}`);
      }

      const result = parseOiHistoryResponse(parsedBody, appSymbolByCoinalyze);
      if (result.kind === "invalid") return invalidSnapshot("coinalyze-oi", fetchedAt, result.detail);
      // P1, fail closed: Coinalyze answers HTTP 200 with `[]` for a symbol it does not know, so an
      // empty (or symbol-incomplete) response is "unavailable", never an `ok` snapshot with no
      // rows — an `ok` snapshot with nothing in it would make `oiChange3dPct` read as a data gap
      // instead of a source problem the owner can fix (found by AC-133's first live run).
      const covered = new Set(result.rows.map((r) => r.key));
      const missing = symbols.filter((s) => !covered.has(s));
      if (missing.length > 0) {
        return unavailableSnapshot(
          "coinalyze-oi",
          fetchedAt,
          `no open-interest history returned for ${missing.join(", ")} (requested ${symbolsCsv}) — check the Coinalyze symbol grammar for these markets`,
        );
      }
      return okSnapshot("coinalyze-oi", fetchedAt, result.rows);
    },
  };
}
