// bybit-oi adapter — specs/daily-catalyst-manual-trading.md §5.3b.
//
// GET /v5/market/open-interest?category=linear&symbol=<BYBIT>&intervalTime=1d&limit=10
// Bybit's own OI history is short (X6), so limit=10 (the spec's literal endpoint) is enough
// for oiChange3dPct's 4-row minimum; deeper OI history is Coinalyze's job (Phase 6, coinalyze-oi).

import { appSymbolToBybit } from "../../bybit/adapters.ts";
import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceRow } from "../types.ts";
import { fetchAllSymbols, invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";
import { acquireBybitSlot } from "./bybit-shared.ts";

const BYBIT_BASE = "https://api.bybit.com";
const OI_PATH = "/v5/market/open-interest";

interface BybitOiResponse {
  retCode?: number;
  retMsg?: string;
  result?: { list?: unknown[] };
}

async function fetchOiForSymbol(
  symbol: string,
  deps: AdapterDeps,
): Promise<{ kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string } | { kind: "unavailable"; detail: string }> {
  const bybitSymbol = appSymbolToBybit(symbol);
  const url = `${BYBIT_BASE}${OI_PATH}?category=linear&symbol=${bybitSymbol}&intervalTime=1d&limit=10`;

  await acquireBybitSlot(OI_PATH);
  const http = await fetchWithRetryPolicy(url, undefined, deps);
  if (http.kind === "unavailable") return { kind: "unavailable", detail: http.detail };

  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return { kind: "invalid", detail: `non-JSON open-interest response for ${symbol} from ${url}` };
  }

  const body = parsed as BybitOiResponse;
  if (body.retCode !== 0 || !Array.isArray(body.result?.list)) {
    return {
      kind: "invalid",
      detail: `unexpected open-interest shape for ${symbol}: retCode=${body.retCode ?? "?"} retMsg="${body.retMsg ?? ""}"`,
    };
  }

  const rows: SourceRow[] = [];
  for (const item of body.result.list as { openInterest?: string; timestamp?: string }[]) {
    const ts = Number(item.timestamp);
    const oi = Number(item.openInterest);
    if (!Number.isFinite(ts) || !Number.isFinite(oi)) {
      return { kind: "invalid", detail: `non-numeric open-interest entry for ${symbol}: ${JSON.stringify(item)}` };
    }
    rows.push({ key: symbol, observedFor: ts, availableAt: ts, field: "oi", value: oi });
  }
  return { kind: "ok", rows };
}

export function createBybitOiAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "bybit-oi",
    maxStalenessMs: 26 * 60 * 60 * 1000,
    async fetch(_decisionTime: number, symbols: readonly string[]) {
      const fetchedAt = deps.now();
      const result = await fetchAllSymbols(symbols, (symbol) => fetchOiForSymbol(symbol, deps));
      if (result.kind === "unavailable") return unavailableSnapshot("bybit-oi", fetchedAt, result.detail);
      if (result.kind === "invalid") return invalidSnapshot("bybit-oi", fetchedAt, result.detail);
      return okSnapshot("bybit-oi", fetchedAt, result.rows);
    },
  };
}
