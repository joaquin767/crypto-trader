// bybit-instruments adapter — specs/daily-catalyst-manual-trading.md §5.3b / §5.5.
//
// GET /v5/market/instruments-info?category=linear&symbol=<BYBIT> — read only by
// instrumentFilters (src/research/planner.ts) for exchange order-size filters. NOT a feature
// input: buildFeatures never reads this source, so it carries no availableAt/P2 semantics
// beyond "availableAt = fetchedAt" recorded on each row for completeness.
//
// Rows: three per symbol — minOrderQty, qtyStep, minNotionalValue — all read from the
// response's lotSizeFilter object, per the spec's endpoint table.

import { appSymbolToBybit } from "../../bybit/adapters.ts";
import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceRow } from "../types.ts";
import { fetchAllSymbols, invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";
import { acquireBybitSlot } from "./bybit-shared.ts";

const BYBIT_BASE = "https://api.bybit.com";
const INSTRUMENTS_PATH = "/v5/market/instruments-info";

interface BybitInstrumentsResponse {
  retCode?: number;
  retMsg?: string;
  result?: { list?: unknown[] };
}

interface LotSizeFilter {
  minOrderQty?: string;
  qtyStep?: string;
  minNotionalValue?: string;
}

/** Pure. Parses one instruments-info `result.list` for its `lotSizeFilter`. Shared by the live
 *  adapter (below) and scripts/backfill-history.ts (A20: backfills use the CURRENT filters for
 *  the whole window). */
export function parseInstrumentsList(
  list: unknown,
  symbol: string,
  fetchedAt: number,
): { kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string } {
  if (!Array.isArray(list)) {
    return { kind: "invalid", detail: `expected an array of instruments for ${symbol}` };
  }
  const entry = (list as { lotSizeFilter?: LotSizeFilter }[])[0];
  const filter = entry?.lotSizeFilter;
  if (!filter) {
    return { kind: "invalid", detail: `instruments-info response for ${symbol} has no lotSizeFilter` };
  }

  const minOrderQty = Number(filter.minOrderQty);
  const qtyStep = Number(filter.qtyStep);
  const minNotionalValue = Number(filter.minNotionalValue);
  if (!Number.isFinite(minOrderQty) || !Number.isFinite(qtyStep) || !Number.isFinite(minNotionalValue)) {
    return { kind: "invalid", detail: `non-numeric lotSizeFilter for ${symbol}: ${JSON.stringify(filter)}` };
  }

  const rows: SourceRow[] = [
    { key: symbol, observedFor: fetchedAt, availableAt: fetchedAt, field: "minOrderQty", value: minOrderQty },
    { key: symbol, observedFor: fetchedAt, availableAt: fetchedAt, field: "qtyStep", value: qtyStep },
    { key: symbol, observedFor: fetchedAt, availableAt: fetchedAt, field: "minNotionalValue", value: minNotionalValue },
  ];
  return { kind: "ok", rows };
}

async function fetchInstrumentForSymbol(
  symbol: string,
  fetchedAt: number,
  deps: AdapterDeps,
): Promise<{ kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string } | { kind: "unavailable"; detail: string }> {
  const bybitSymbol = appSymbolToBybit(symbol);
  const url = `${BYBIT_BASE}${INSTRUMENTS_PATH}?category=linear&symbol=${bybitSymbol}`;

  await acquireBybitSlot(INSTRUMENTS_PATH);
  const http = await fetchWithRetryPolicy(url, undefined, deps);
  if (http.kind === "unavailable") return { kind: "unavailable", detail: http.detail };

  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    return { kind: "invalid", detail: `non-JSON instruments-info response for ${symbol} from ${url}` };
  }

  const body = parsed as BybitInstrumentsResponse;
  if (body.retCode !== 0 || !Array.isArray(body.result?.list)) {
    return {
      kind: "invalid",
      detail: `unexpected instruments-info shape for ${symbol}: retCode=${body.retCode ?? "?"} retMsg="${body.retMsg ?? ""}"`,
    };
  }

  return parseInstrumentsList(body.result.list, symbol, fetchedAt);
}

export function createBybitInstrumentsAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "bybit-instruments",
    maxStalenessMs: 7 * 24 * 60 * 60 * 1000,
    async fetch(_decisionTime: number, symbols: readonly string[]) {
      const fetchedAt = deps.now();
      const result = await fetchAllSymbols(symbols, (symbol) => fetchInstrumentForSymbol(symbol, fetchedAt, deps));
      if (result.kind === "unavailable") return unavailableSnapshot("bybit-instruments", fetchedAt, result.detail);
      if (result.kind === "invalid") return invalidSnapshot("bybit-instruments", fetchedAt, result.detail);
      return okSnapshot("bybit-instruments", fetchedAt, result.rows);
    },
  };
}
