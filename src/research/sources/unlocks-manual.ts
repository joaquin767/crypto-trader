// unlocks-manual adapter — specs/daily-catalyst-manual-trading.md §5.3b.
//
// Reads the committed, owner-maintained data/manual/unlocks.json. Feeds daysToNextUnlock and
// nextUnlockPctOfFloat. Per §5.3a, row `availableAt` is the snapshot's fetchedAt (conservative),
// but staleness is judged by the file's `asOf` (≤7d old) — so, like macro-calendar-manual, we
// carry one extra "asOf" meta row (key "_meta") for src/research/features.ts to find; it is not
// itself an unlock and is skipped when reading real content.
//
// Each real row's `key` is the unlocking asset (e.g. "APT"), `observedFor` is the unlock time
// (an event time, not a day-start — SourceRow.observedFor supports both), and `value` is
// `pctOfCirculating`; this lets features.ts recover both the timing and the magnitude from one
// row per unlock.

import type { AdapterDeps } from "../http.ts";
import type { SourceAdapter, SourceRow, UnlocksFile } from "../types.ts";
import { invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";

export const UNLOCKS_PATH = "data/manual/unlocks.json";
export const META_ASOF_FIELD = "asOf";
export const META_KEY = "_meta";

export function createUnlocksManualAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "unlocks-manual",
    maxStalenessMs: 7 * 24 * 60 * 60 * 1000,
    async fetch() {
      const fetchedAt = deps.now();
      if (!deps.fileExists(UNLOCKS_PATH)) {
        return unavailableSnapshot("unlocks-manual", fetchedAt, `missing file ${UNLOCKS_PATH}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(deps.readFile(UNLOCKS_PATH));
      } catch (err) {
        return invalidSnapshot("unlocks-manual", fetchedAt, `invalid JSON in ${UNLOCKS_PATH}: ${(err as Error).message}`);
      }

      const file = parsed as Partial<UnlocksFile>;
      if (typeof file.asOf !== "string" || !Array.isArray(file.unlocks)) {
        return invalidSnapshot("unlocks-manual", fetchedAt, `unexpected shape in ${UNLOCKS_PATH}`);
      }
      const asOfMs = Date.parse(`${file.asOf}T00:00:00Z`);
      if (!Number.isFinite(asOfMs)) {
        return invalidSnapshot("unlocks-manual", fetchedAt, `unparseable asOf "${file.asOf}" in ${UNLOCKS_PATH}`);
      }

      const rows: SourceRow[] = [{ key: META_KEY, observedFor: asOfMs, availableAt: fetchedAt, field: META_ASOF_FIELD, value: file.asOf }];
      for (const [i, u] of file.unlocks.entries()) {
        if (!u || typeof u.asset !== "string" || typeof u.time !== "string" || typeof u.pctOfCirculating !== "number") {
          return invalidSnapshot("unlocks-manual", fetchedAt, `malformed unlock at index ${i} in ${UNLOCKS_PATH}`);
        }
        const t = Date.parse(u.time);
        if (!Number.isFinite(t)) {
          return invalidSnapshot("unlocks-manual", fetchedAt, `unparseable unlock time "${u.time}" at index ${i}`);
        }
        rows.push({ key: u.asset, observedFor: t, availableAt: fetchedAt, field: "unlock", value: u.pctOfCirculating });
      }
      return okSnapshot("unlocks-manual", fetchedAt, rows);
    },
  };
}
