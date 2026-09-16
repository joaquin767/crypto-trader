// bybit-funding adapter — specs/daily-catalyst-manual-trading.md §5.3b.
//
// GET /v5/market/funding/history?category=linear&symbol=<BYBIT>&limit=200, paged back with
// `endTime` to cover the 90 days that fundingRatePercentile90d needs. `availableAt` is the
// settlement time itself (funding history is public and PIT the moment it settles).

import { appSymbolToBybit } from "../../bybit/adapters.ts";
import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceRow } from "../types.ts";
import { fetchAllSymbols, invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";
import { acquireBybitSlot } from "./bybit-shared.ts";

const BYBIT_BASE = "https://api.bybit.com";
const FUNDING_PATH = "/v5/market/funding/history";
const PAGE_LIMIT = 200;
const MAX_PAGES = 5; // 5 * 200 = 1000 rows — generously covers 90d of 3x/day settlements (~270).
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

interface BybitFundingResponse {
  retCode?: number;
  retMsg?: string;
  result?: { list?: unknown[] };
}

async function fetchFundingForSymbol(
  symbol: string,
  decisionTime: number,
  deps: AdapterDeps,
): Promise<{ kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string } | { kind: "unavailable"; detail: string }> {
  const bybitSymbol = appSymbolToBybit(symbol);
  const targetStart = decisionTime - LOOKBACK_MS;
  const rows: SourceRow[] = [];
  const seen = new Set<number>();
  let endTime: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${BYBIT_BASE}${FUNDING_PATH}?category=linear&symbol=${bybitSymbol}&limit=${PAGE_LIMIT}` +
      (endTime !== undefined ? `&endTime=${endTime}` : "");

    await acquireBybitSlot(FUNDING_PATH);
    const http = await fetchWithRetryPolicy(url, undefined, deps);
    if (http.kind === "unavailable") return { kind: "unavailable", detail: http.detail };

    let parsed: unknown;
    try {
      parsed = JSON.parse(http.body);
    } catch {
      return { kind: "invalid", detail: `non-JSON funding response for ${symbol} from ${url}` };
    }

    const body = parsed as BybitFundingResponse;
    if (body.retCode !== 0 || !Array.isArray(body.result?.list)) {
      return {
        kind: "invalid",
        detail: `unexpected funding shape for ${symbol}: retCode=${body.retCode ?? "?"} retMsg="${body.retMsg ?? ""}"`,
      };
    }

    const list = body.result.list as { fundingRate?: string; fundingRateTimestamp?: string }[];
    if (list.length === 0) break;

    let minTs = Number.POSITIVE_INFINITY;
    for (const item of list) {
      const ts = Number(item.fundingRateTimestamp);
      const rate = Number(item.fundingRate);
      if (!Number.isFinite(ts) || !Number.isFinite(rate)) {
        return { kind: "invalid", detail: `non-numeric funding entry for ${symbol}: ${JSON.stringify(item)}` };
      }
      if (ts < minTs) minTs = ts;
      if (seen.has(ts)) continue;
      seen.add(ts);
      rows.push({ key: symbol, observedFor: ts, availableAt: ts, field: "fundingRate", value: rate });
    }

    if (list.length < PAGE_LIMIT || minTs <= targetStart) break;
    endTime = minTs - 1;
  }

  return { kind: "ok", rows };
}

export function createBybitFundingAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "bybit-funding",
    maxStalenessMs: 9 * 60 * 60 * 1000,
    async fetch(decisionTime: number, symbols: readonly string[]) {
      const fetchedAt = deps.now();
      const result = await fetchAllSymbols(symbols, (symbol) => fetchFundingForSymbol(symbol, decisionTime, deps));
      if (result.kind === "unavailable") return unavailableSnapshot("bybit-funding", fetchedAt, result.detail);
      if (result.kind === "invalid") return invalidSnapshot("bybit-funding", fetchedAt, result.detail);
      return okSnapshot("bybit-funding", fetchedAt, result.rows);
    },
  };
}
