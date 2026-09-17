// fear-greed adapter — specs/daily-catalyst-manual-trading.md §5.3b.
//
// GET https://api.alternative.me/fng/?limit=10&format=json — free, no key. Feeds the
// `fearGreed` feature. `availableAt` is the snapshot's fetchedAt (conservative, §5.3a).

import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceRow } from "../types.ts";
import { invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";

const FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=10&format=json";

interface FearGreedResponse {
  data?: { value?: string; timestamp?: string }[];
}

export type FearGreedEntry = { value: number; timestampS: number };

/** Pure. Parses alternative.me's `data[]` array. Shared by the live adapter (below) and
 *  scripts/backfill-history.ts. */
export function parseFearGreedList(parsed: unknown): { kind: "ok"; entries: FearGreedEntry[] } | { kind: "invalid"; detail: string } {
  const body = parsed as FearGreedResponse;
  if (!Array.isArray(body.data)) {
    return { kind: "invalid", detail: "unexpected fear & greed response shape (no data[])" };
  }
  const entries: FearGreedEntry[] = [];
  for (const entry of body.data) {
    const value = Number(entry.value);
    const timestampS = Number(entry.timestamp);
    if (!Number.isFinite(value) || !Number.isFinite(timestampS)) {
      return { kind: "invalid", detail: `malformed fear & greed entry: ${JSON.stringify(entry)}` };
    }
    entries.push({ value, timestampS });
  }
  return { kind: "ok", entries };
}

export function createFearGreedAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "fear-greed",
    maxStalenessMs: 26 * 60 * 60 * 1000,
    async fetch() {
      const fetchedAt = deps.now();
      const http = await fetchWithRetryPolicy(FEAR_GREED_URL, undefined, deps);
      if (http.kind === "unavailable") return unavailableSnapshot("fear-greed", fetchedAt, http.detail);

      let parsed: unknown;
      try {
        parsed = JSON.parse(http.body);
      } catch {
        return invalidSnapshot("fear-greed", fetchedAt, "non-JSON response from alternative.me fng");
      }

      const list = parseFearGreedList(parsed);
      if (list.kind === "invalid") return invalidSnapshot("fear-greed", fetchedAt, list.detail);

      const rows: SourceRow[] = list.entries.map((e) => (
        { key: "BTC", observedFor: e.timestampS * 1000, availableAt: fetchedAt, field: "fearGreedIndex", value: e.value }
      ));
      return okSnapshot("fear-greed", fetchedAt, rows);
    },
  };
}
