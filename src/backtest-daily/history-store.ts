// Backfilled history store — specs/daily-catalyst-manual-trading.md §5.10a "History store".
//
// `snapshotsAt` is the backtest's point-in-time replacement for a live day's `readSnapshots()`
// call: given the whole backfilled history for a source and a decision time T, it produces the
// exact `SourceSnapshot` that a live run would have seen on that day, so `buildFeatures` (P2,
// fail-closed) runs completely unchanged in both live and backtest code paths.
//
// `loadHistory`/`saveHistoryFile` are the only I/O in this module; `snapshotsAt` itself is pure.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { okSnapshot, unavailableSnapshot } from "../research/sources/common.ts";
import type { SourceId, SourceRow, SourceSnapshot } from "../research/types.ts";

/** One file per source: data/history/<sourceId>.json (gitignored), rows with availableAt set
 *  per §10.3. */
export interface HistoryFile {
  sourceId: SourceId;
  builtAt: number;
  coverage: { from: number; to: number };
  rows: SourceRow[];
}

// Manual sources (macro calendar, unlocks) are always "as fresh as the decision day": the owner
// is assumed to keep them current, so §5.10a has snapshotsAt synthesize the `_meta` asOf row
// (read by src/research/features.ts's findAsOfMs) using T's own UTC date, rather than relying on
// anything recorded in the history file itself.
const MANUAL_SOURCE_IDS = new Set<SourceId>(["macro-calendar-manual", "unlocks-manual"]);
const META_KEY = "_meta";
const META_ASOF_FIELD = "asOf";

function utcDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Pure. Point-in-time view at decision time T: for each source, rows with availableAt ≤ T.
 * The snapshot's `fetchedAt` = the newest such row's `availableAt` (NOT T), so buildFeatures'
 * staleness check flags gaps in history exactly as it would live. No visible rows → status
 * "unavailable", detail "no history before T". Manual sources get a synthesized `_meta` asOf
 * row equal to T's UTC date (schedules are known ahead, §10.3).
 */
export function snapshotsAt(history: readonly HistoryFile[], decisionTime: number): SourceSnapshot[] {
  return history.map((file) => {
    const visible = file.rows.filter((r) => r.availableAt <= decisionTime);

    if (MANUAL_SOURCE_IDS.has(file.sourceId)) {
      const dateStr = utcDateStr(decisionTime);
      const asOfMs = Date.parse(`${dateStr}T00:00:00Z`);
      const metaRow: SourceRow = { key: META_KEY, observedFor: asOfMs, availableAt: asOfMs, field: META_ASOF_FIELD, value: dateStr };
      const rows = [metaRow, ...visible];
      const fetchedAt = Math.max(...rows.map((r) => r.availableAt));
      return okSnapshot(file.sourceId, fetchedAt, rows);
    }

    if (visible.length === 0) {
      return unavailableSnapshot(file.sourceId, decisionTime, "no history before T");
    }
    const fetchedAt = Math.max(...visible.map((r) => r.availableAt));
    return okSnapshot(file.sourceId, fetchedAt, visible);
  });
}

/** Reads every `<dir>/<sourceId>.json` history file. Fails closed: an unparseable or
 *  malformed-shape file throws (naming the file), never silently skipped. Missing directory
 *  yields an empty array (nothing backfilled yet). */
export function loadHistory(dir: string): HistoryFile[] {
  if (!existsSync(dir)) return [];
  const files: HistoryFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      throw new Error(`unparseable history file "${name}": ${(err as Error).message}`);
    }
    const f = parsed as Partial<HistoryFile> | null;
    if (
      f === null || typeof f !== "object" ||
      typeof f.sourceId !== "string" ||
      typeof f.builtAt !== "number" ||
      typeof f.coverage !== "object" || f.coverage === null ||
      typeof f.coverage.from !== "number" || typeof f.coverage.to !== "number" ||
      !Array.isArray(f.rows)
    ) {
      throw new Error(`malformed history file "${name}": missing sourceId/builtAt/coverage/rows`);
    }
    files.push(f as HistoryFile);
  }
  return files;
}

/** Atomic write (write to a temp file in the same directory, then rename), same convention as
 *  src/research/snapshot-store.ts. */
export function saveHistoryFile(dir: string, file: HistoryFile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${file.sourceId}.json`);
  const tmpPath = join(dir, `.${file.sourceId}.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmpPath, path);
  return path;
}
