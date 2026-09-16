// macro-calendar-manual adapter — specs/daily-catalyst-manual-trading.md §5.3b.
//
// Reads the committed, owner-maintained data/manual/macro-calendar.json. Feeds hoursToNextFomc.
// Staleness is judged by the file's `asOf` field, not by fetch time (§5.3a) — a stale schedule
// is stale even if you just re-read the file a second ago. We record that as one extra
// "asOf" meta row (key "_meta") so src/research/features.ts can find it without a separate
// SourceSnapshot field; feature builders skip rows with key "_meta" when reading real content.
// Every row's `availableAt` is Date.parse(asOf) per §5.3a.

import type { AdapterDeps } from "../http.ts";
import type { MacroCalendarFile, SourceAdapter, SourceRow } from "../types.ts";
import { invalidSnapshot, okSnapshot, unavailableSnapshot } from "./common.ts";

export const MACRO_CALENDAR_PATH = "data/manual/macro-calendar.json";
export const META_ASOF_FIELD = "asOf";
export const META_KEY = "_meta";

export function createMacroCalendarManualAdapter(deps: AdapterDeps): SourceAdapter {
  return {
    id: "macro-calendar-manual",
    maxStalenessMs: 120 * 24 * 60 * 60 * 1000,
    async fetch() {
      const fetchedAt = deps.now();
      if (!deps.fileExists(MACRO_CALENDAR_PATH)) {
        return unavailableSnapshot("macro-calendar-manual", fetchedAt, `missing file ${MACRO_CALENDAR_PATH}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(deps.readFile(MACRO_CALENDAR_PATH));
      } catch (err) {
        return invalidSnapshot("macro-calendar-manual", fetchedAt, `invalid JSON in ${MACRO_CALENDAR_PATH}: ${(err as Error).message}`);
      }

      const file = parsed as Partial<MacroCalendarFile>;
      if (typeof file.asOf !== "string" || !Array.isArray(file.events)) {
        return invalidSnapshot("macro-calendar-manual", fetchedAt, `unexpected shape in ${MACRO_CALENDAR_PATH}`);
      }
      const asOfMs = Date.parse(`${file.asOf}T00:00:00Z`);
      if (!Number.isFinite(asOfMs)) {
        return invalidSnapshot("macro-calendar-manual", fetchedAt, `unparseable asOf "${file.asOf}" in ${MACRO_CALENDAR_PATH}`);
      }

      const rows: SourceRow[] = [{ key: META_KEY, observedFor: asOfMs, availableAt: asOfMs, field: META_ASOF_FIELD, value: file.asOf }];
      for (const [i, ev] of file.events.entries()) {
        if (!ev || ev.type !== "FOMC" || typeof ev.time !== "string") {
          return invalidSnapshot("macro-calendar-manual", fetchedAt, `malformed event at index ${i} in ${MACRO_CALENDAR_PATH}`);
        }
        const t = Date.parse(ev.time);
        if (!Number.isFinite(t)) {
          return invalidSnapshot("macro-calendar-manual", fetchedAt, `unparseable event time "${ev.time}" at index ${i}`);
        }
        rows.push({ key: "FOMC", observedFor: t, availableAt: asOfMs, field: "eventTime", value: ev.time });
      }
      return okSnapshot("macro-calendar-manual", fetchedAt, rows);
    },
  };
}
