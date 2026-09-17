// bybit-klines-1d / bybit-klines-1h adapters — specs/daily-catalyst-manual-trading.md §5.3b.
//
// GET /v5/market/kline?category=linear&symbol=<BYBIT>&interval=<D|60>&limit=<n>
// Each bar becomes 5 rows (one per OHLCV field) so the generic SourceRow shape (one value per
// row) can carry a full bar; src/research/features.ts regroups them by `observedFor` (bar open
// time). `availableAt` is the bar's close time (open + interval), matching §5.3a: a bar counts
// only once it has actually closed.

import { appSymbolToBybit } from "../../bybit/adapters.ts";
import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceId, SourceRow } from "../types.ts";
import { fetchAllSymbols, invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";
import { acquireBybitSlot } from "./bybit-shared.ts";

const BYBIT_BASE = "https://api.bybit.com";
const KLINE_PATH = "/v5/market/kline";

interface BybitKlineResponse {
  retCode?: number;
  retMsg?: string;
  result?: { list?: unknown[] };
}

interface KlineAdapterOpts {
  id: SourceId;
  interval: "D" | "60";
  limit: number;
  barIntervalMs: number;
  maxStalenessMs: number;
}

async function fetchKlinesForSymbol(
  symbol: string,
  opts: KlineAdapterOpts,
  deps: AdapterDeps,
): Promise<{ kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string } | { kind: "unavailable"; detail: string }> {
  const bybitSymbol = appSymbolToBybit(symbol);
  const url = `${BYBIT_BASE}${KLINE_PATH}?category=linear&symbol=${bybitSymbol}&interval=${opts.interval}&limit=${opts.limit}`;

  await acquireBybitSlot(KLINE_PATH);
  const http = await fetchWithRetryPolicy(url, undefined, deps);
  if (http.kind === "unavailable") return { kind: "unavailable", detail: http.detail };

  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return { kind: "invalid", detail: `non-JSON kline response for ${symbol} from ${url}` };
  }

  const body = parsed as BybitKlineResponse;
  if (body.retCode !== 0 || !Array.isArray(body.result?.list)) {
    return {
      kind: "invalid",
      detail: `unexpected kline shape for ${symbol}: retCode=${body.retCode ?? "?"} retMsg="${body.retMsg ?? ""}"`,
    };
  }

  const rows: SourceRow[] = [];
  for (const bar of body.result.list) {
    if (!Array.isArray(bar) || bar.length < 6) {
      return { kind: "invalid", detail: `malformed kline bar for ${symbol}: ${JSON.stringify(bar)}` };
    }
    const [startStr, openStr, highStr, lowStr, closeStr, volumeStr] = bar as string[];
    const t = Number(startStr);
    const o = Number(openStr);
    const h = Number(highStr);
    const l = Number(lowStr);
    const c = Number(closeStr);
    const v = Number(volumeStr);
    if (![t, o, h, l, c, v].every(Number.isFinite)) {
      return { kind: "invalid", detail: `non-numeric kline field for ${symbol}: ${JSON.stringify(bar)}` };
    }
    const availableAt = t + opts.barIntervalMs;
    rows.push(
      { key: symbol, observedFor: t, availableAt, field: "open", value: o },
      { key: symbol, observedFor: t, availableAt, field: "high", value: h },
      { key: symbol, observedFor: t, availableAt, field: "low", value: l },
      { key: symbol, observedFor: t, availableAt, field: "close", value: c },
      { key: symbol, observedFor: t, availableAt, field: "volume", value: v },
    );
  }
  return { kind: "ok", rows };
}

function createBybitKlinesAdapter(opts: KlineAdapterOpts, deps: AdapterDeps): SourceAdapter {
  return {
    id: opts.id,
    maxStalenessMs: opts.maxStalenessMs,
    async fetch(_decisionTime: number, symbols: readonly string[]) {
      const fetchedAt = deps.now();
      const result = await fetchAllSymbols(symbols, (symbol) => fetchKlinesForSymbol(symbol, opts, deps));
      if (result.kind === "unavailable") return unavailableSnapshot(opts.id, fetchedAt, result.detail);
      if (result.kind === "invalid") return invalidSnapshot(opts.id, fetchedAt, result.detail);
      return okSnapshot(opts.id, fetchedAt, result.rows);
    },
  };
}

export function createBybitKlines1dAdapter(deps: AdapterDeps): SourceAdapter {
  return createBybitKlinesAdapter(
    { id: "bybit-klines-1d", interval: "D", limit: 100, barIntervalMs: 24 * 60 * 60 * 1000, maxStalenessMs: 26 * 60 * 60 * 1000 },
    deps,
  );
}

export function createBybitKlines1hAdapter(deps: AdapterDeps): SourceAdapter {
  return createBybitKlinesAdapter(
    { id: "bybit-klines-1h", interval: "60", limit: 200, barIntervalMs: 60 * 60 * 1000, maxStalenessMs: 2 * 60 * 60 * 1000 },
    deps,
  );
}
