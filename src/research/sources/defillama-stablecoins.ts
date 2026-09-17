// defillama-stablecoins adapter — specs/daily-catalyst-manual-trading.md §5.3b.
//
// GET https://stablecoins.llama.fi/stablecoincharts/all — free, no key. Feeds
// stablecoinSupplyChange7dPct. `availableAt` is the snapshot's fetchedAt (conservative, §5.3a).

import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceRow } from "../types.ts";
import { invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";

const DEFILLAMA_URL = "https://stablecoins.llama.fi/stablecoincharts/all";

interface DefillamaChartPoint {
  date?: string; // unix seconds, as a string
  totalCirculatingUSD?: { peggedUSD?: number };
}

export type StablecoinPoint = { dateSeconds: number; totalUsd: number };

/** Pure. Parses the DefiLlama `stablecoincharts/all` array (the whole history in one response).
 *  Shared by the live adapter (below) and scripts/backfill-history.ts. */
export function parseStablecoinChart(parsed: unknown): { kind: "ok"; points: StablecoinPoint[] } | { kind: "invalid"; detail: string } {
  if (!Array.isArray(parsed)) {
    return { kind: "invalid", detail: "expected a JSON array from DefiLlama stablecoincharts" };
  }
  const points: StablecoinPoint[] = [];
  for (const point of parsed as DefillamaChartPoint[]) {
    const dateSeconds = Number(point.date);
    const total = point.totalCirculatingUSD?.peggedUSD;
    if (!Number.isFinite(dateSeconds) || typeof total !== "number" || !Number.isFinite(total)) {
      return { kind: "invalid", detail: `malformed stablecoin chart point: ${JSON.stringify(point)}` };
    }
    points.push({ dateSeconds, totalUsd: total });
  }
  return { kind: "ok", points };
}

export function createDefillamaStablecoinsAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "defillama-stablecoins",
    maxStalenessMs: 48 * 60 * 60 * 1000,
    async fetch() {
      const fetchedAt = deps.now();
      const http = await fetchWithRetryPolicy(DEFILLAMA_URL, undefined, deps);
      if (http.kind === "unavailable") return unavailableSnapshot("defillama-stablecoins", fetchedAt, http.detail);

      let parsed: unknown;
      try {
        parsed = JSON.parse(http.body);
      } catch {
        return invalidSnapshot("defillama-stablecoins", fetchedAt, "non-JSON response from DefiLlama stablecoincharts");
      }
      const chart = parseStablecoinChart(parsed);
      if (chart.kind === "invalid") return invalidSnapshot("defillama-stablecoins", fetchedAt, chart.detail);

      const rows: SourceRow[] = chart.points.map((p) => (
        { key: "ALL", observedFor: p.dateSeconds * 1000, availableAt: fetchedAt, field: "totalSupplyUsd", value: p.totalUsd }
      ));
      return okSnapshot("defillama-stablecoins", fetchedAt, rows);
    },
  };
}
