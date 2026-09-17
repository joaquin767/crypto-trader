// Public market data (paged klines) — specs/daily-catalyst-manual-trading.md §5.14.
//
// I/O only: fetches Bybit's public kline endpoint, paged backwards because a single request is
// capped at `limit` bars and Bybit returns them newest-first. Fails closed (P1, AC-71): any HTTP
// error, unexpected response shape, or malformed bar aborts the whole fetch and resolves null —
// never a partial series silently handed to the chart or a review's MAE/MFE calculation.
//
// Replaces the old `fetchKlines1hPublic` in src/server/journal-server.ts, which capped its
// request to 200 bars without paging even though `maxHoldDays` allows much longer holds.

import { appSymbolToBybit } from "../bybit/adapters.ts";
import type { AdapterDeps } from "../research/http.ts";
import { fetchWithRetryPolicy } from "../research/http.ts";
import type { Kline } from "../research/types.ts";
import type { ChartInterval } from "./chart.ts";
import { INTERVAL_MS } from "./chart.ts";

const BYBIT_BASE = "https://api.bybit.com";
const KLINE_PATH = "/v5/market/kline";
const PAGE_LIMIT = 1000;

interface BybitKlineResponse {
  retCode?: number;
  retMsg?: string;
  result?: { list?: unknown[] };
}

function parseBar(bar: unknown): Kline | null {
  if (!Array.isArray(bar) || bar.length < 6) return null;
  const [t, o, h, l, c, v] = (bar as string[]).map(Number);
  if (![t, o, h, l, c, v].every(Number.isFinite)) return null;
  return { t: t!, o: o!, h: h!, l: l!, c: c!, v: v! };
}

async function fetchPage(
  symbol: string,
  interval: ChartInterval | "D",
  startMs: number,
  endMs: number,
  deps: Pick<AdapterDeps, "fetch" | "sleep">,
): Promise<Kline[] | null> {
  const bybitSymbol = appSymbolToBybit(symbol);
  const url = `${BYBIT_BASE}${KLINE_PATH}?category=linear&symbol=${bybitSymbol}&interval=${interval}&start=${startMs}&end=${endMs}&limit=${PAGE_LIMIT}`;
  const http = await fetchWithRetryPolicy(url, undefined, deps);
  if (http.kind === "unavailable") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return null;
  }
  const body = parsed as BybitKlineResponse;
  if (body.retCode !== 0 || !Array.isArray(body.result?.list)) return null;

  const klines: Kline[] = [];
  for (const bar of body.result.list) {
    const k = parseBar(bar);
    if (k === null) return null;
    klines.push(k);
  }
  return klines; // newest-first, per Bybit
}

/** Public Bybit `/v5/market/kline`, paged backwards by moving `end` to (oldest bar `t` − 1)
 *  until `startMs` is covered or a page comes back empty (≤ 1000 bars/request). Deduped by open
 *  time, returned ascending. Resolves null on any HTTP/shape error — never a partial series
 *  (P1, AC-71). */
export async function fetchKlines(
  symbol: string,
  interval: ChartInterval | "D",
  startMs: number,
  endMs: number,
  deps: Pick<AdapterDeps, "fetch" | "sleep">,
): Promise<Kline[] | null> {
  const barMs = INTERVAL_MS[interval];
  const byTime = new Map<number, Kline>();
  let end = endMs;
  // Generous safety bound on page count — real windows need at most a handful of pages, but a
  // buggy/adversarial server that never returns an empty page or covers startMs must not hang.
  const maxPages = Math.max(50, Math.ceil((endMs - startMs) / barMs / PAGE_LIMIT) + 10);

  for (let page = 0; page < maxPages; page++) {
    const bars = await fetchPage(symbol, interval, startMs, end, deps);
    if (bars === null) return null;
    if (bars.length === 0) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const bar of bars) {
      byTime.set(bar.t, bar);
      if (bar.t < oldest) oldest = bar.t;
    }
    if (oldest <= startMs) break;
    end = oldest - 1;
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Splits the newest bar out of an ascending kline array into `formingCandle` when its close
 *  time (`t + interval`) is still in the future — it has not closed yet and must be drawn
 *  dashed, never treated as a finished bar (§5.14). */
export function splitFormingCandle(
  candles: readonly Kline[],
  interval: ChartInterval,
  now: number,
): { candles: Kline[]; formingCandle: Kline | null } {
  if (candles.length === 0) return { candles: [], formingCandle: null };
  const barMs = INTERVAL_MS[interval];
  const last = candles[candles.length - 1]!;
  if (last.t + barMs > now) {
    return { candles: candles.slice(0, -1), formingCandle: last };
  }
  return { candles: [...candles], formingCandle: null };
}
