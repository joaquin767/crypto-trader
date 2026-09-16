// Shared helpers for building SourceSnapshot results — every adapter uses these so the
// "adapters never reject" and "sha256 of JSON.stringify(rows)" contracts (§5.1) hold uniformly.

import { createHash } from "node:crypto";

import type { SourceId, SourceRow, SourceSnapshot } from "../types.ts";

function sha256OfRows(rows: readonly SourceRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function okSnapshot(sourceId: SourceId, fetchedAt: number, rows: SourceRow[]): SourceSnapshot {
  return { sourceId, fetchedAt, status: "ok", statusDetail: "", rows, sha256: sha256OfRows(rows) };
}

export function unavailableSnapshot(sourceId: SourceId, fetchedAt: number, detail: string): SourceSnapshot {
  return { sourceId, fetchedAt, status: "unavailable", statusDetail: detail, rows: [], sha256: sha256OfRows([]) };
}

export function invalidSnapshot(sourceId: SourceId, fetchedAt: number, detail: string): SourceSnapshot {
  return { sourceId, fetchedAt, status: "invalid", statusDetail: detail, rows: [], sha256: sha256OfRows([]) };
}

export type SymbolFetchResult =
  | { kind: "ok"; rows: SourceRow[] }
  | { kind: "invalid"; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * Fetch one source's rows for every symbol, sequentially. The first symbol that comes back
 * "invalid" or "unavailable" decides the whole snapshot's status — we never emit partial rows
 * for a subset of symbols (P1: fail closed, never substitute).
 */
export async function fetchAllSymbols(
  symbols: readonly string[],
  fetchOne: (symbol: string) => Promise<SymbolFetchResult>,
): Promise<SymbolFetchResult> {
  const rows: SourceRow[] = [];
  for (const symbol of symbols) {
    const result = await fetchOne(symbol);
    if (result.kind !== "ok") return result;
    rows.push(...result.rows);
  }
  return { kind: "ok", rows };
}
