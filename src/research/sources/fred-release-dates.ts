// fred-release-dates adapter — specs/daily-catalyst-manual-trading.md §5.3b.
//
// GET https://api.stlouisfed.org/fred/release/dates?release_id=<CPI>&...&api_key=$FRED_API_KEY
// Feeds hoursToNextCpi. Missing FRED_API_KEY is not a crash — it's an "unavailable" snapshot
// (§10.2), the exact wording checked by AC-51's sibling for this source.

import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceRow } from "../types.ts";
import { invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";

const FRED_BASE = "https://api.stlouisfed.org/fred/release/dates";

/**
 * CPI (Consumer Price Index for All Urban Consumers) release id, verified 2026-09-16 against
 * https://fred.stlouisfed.org/release?rid=10 — page <title> is
 * "Consumer Price Index | FRED | St. Louis Fed", confirming release_id 10 is CPI.
 */
export const FRED_CPI_RELEASE_ID = 10;

interface FredReleaseDatesResponse {
  release_dates?: { release_id: number; date: string }[];
  error_message?: string;
}

export function createFredReleaseDatesAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "fred-release-dates",
    maxStalenessMs: 7 * 24 * 60 * 60 * 1000,
    async fetch() {
      const fetchedAt = deps.now();
      const apiKey = process.env["FRED_API_KEY"];
      if (!apiKey) {
        return unavailableSnapshot("fred-release-dates", fetchedAt, "FRED_API_KEY not set");
      }

      const url =
        `${FRED_BASE}?release_id=${FRED_CPI_RELEASE_ID}&include_release_dates_with_no_data=true` +
        `&sort_order=desc&file_type=json&api_key=${apiKey}`;
      const http = await fetchWithRetryPolicy(url, undefined, deps);
      if (http.kind === "unavailable") return unavailableSnapshot("fred-release-dates", fetchedAt, http.detail);

      let parsed: unknown;
      try {
        parsed = JSON.parse(http.body);
      } catch {
        return invalidSnapshot("fred-release-dates", fetchedAt, "non-JSON response from FRED release/dates");
      }

      const body = parsed as FredReleaseDatesResponse;
      if (!Array.isArray(body.release_dates)) {
        return invalidSnapshot(
          "fred-release-dates",
          fetchedAt,
          `unexpected FRED response shape${body.error_message ? `: ${body.error_message}` : ""}`,
        );
      }

      const rows: SourceRow[] = [];
      for (const rd of body.release_dates) {
        const t = Date.parse(`${rd.date}T00:00:00Z`);
        if (!Number.isFinite(t)) {
          return invalidSnapshot("fred-release-dates", fetchedAt, `unparseable release date "${rd.date}"`);
        }
        rows.push({ key: "CPI", observedFor: t, availableAt: fetchedAt, field: "releaseDate", value: rd.date });
      }
      return okSnapshot("fred-release-dates", fetchedAt, rows);
    },
  };
}
