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
      if (!Array.isArray(parsed)) {
        return invalidSnapshot("defillama-stablecoins", fetchedAt, "expected a JSON array from DefiLlama stablecoincharts");
      }

      const rows: SourceRow[] = [];
      for (const point of parsed as DefillamaChartPoint[]) {
        const dateSeconds = Number(point.date);
        const total = point.totalCirculatingUSD?.peggedUSD;
        if (!Number.isFinite(dateSeconds) || typeof total !== "number" || !Number.isFinite(total)) {
          return invalidSnapshot("defillama-stablecoins", fetchedAt, `malformed stablecoin chart point: ${JSON.stringify(point)}`);
        }
        rows.push({ key: "ALL", observedFor: dateSeconds * 1000, availableAt: fetchedAt, field: "totalSupplyUsd", value: total });
      }
      return okSnapshot("defillama-stablecoins", fetchedAt, rows);
    },
  };
}
