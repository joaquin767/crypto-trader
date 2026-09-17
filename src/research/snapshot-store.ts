// Write-once daily snapshot store — specs/daily-catalyst-manual-trading.md §5.2.
//
// Layout: <rootDir>/<dateUtc>/<sourceId>.json (revision 0, the default) or
// <rootDir>/<dateUtc>/<sourceId>.r<revision>.json for revision > 0. Every file's `sha256`
// field is computed by this module (never trusted from the caller) so a byte edited on disk
// after the fact is caught on the next read (AC-5).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { SourceSnapshot } from "./types.ts";

export class SnapshotExistsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Snapshot already exists at "${path}" — snapshots are write-once; pass a revision to add a new one.`);
    this.name = "SnapshotExistsError";
    this.path = path;
  }
}

const DEFAULT_ROOT_DIR = "data/snapshots";

function sha256OfRows(rows: unknown): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function filenameFor(sourceId: string, revision: number): string {
  return revision > 0 ? `${sourceId}.r${revision}.json` : `${sourceId}.json`;
}

/**
 * Write-once. Throws SnapshotExistsError if the file exists (unless revision > 0 writes
 * <sourceId>.r<revision>.json, itself write-once at that revision).
 */
export function writeSnapshot(
  dateUtc: string,
  snap: SourceSnapshot,
  opts?: { revision?: number; rootDir?: string },
): string {
  const rootDir = opts?.rootDir ?? DEFAULT_ROOT_DIR;
  const revision = opts?.revision ?? 0;
  const dir = join(rootDir, dateUtc);
  mkdirSync(dir, { recursive: true });

  const path = join(dir, filenameFor(snap.sourceId, revision));
  if (existsSync(path)) {
    throw new SnapshotExistsError(path);
  }

  const record: SourceSnapshot = { ...snap, sha256: sha256OfRows(snap.rows) };
  try {
    // "wx" refuses to overwrite an existing file — belt-and-suspenders against a
    // check-then-write race with the existsSync check above.
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SnapshotExistsError(path);
    }
    throw err;
  }
  return path;
}

/** Returns latest revision per source for the date; empty array if the directory does not exist.
 *  Throws on SHA mismatch. */
export function readSnapshots(dateUtc: string, opts?: { rootDir?: string }): SourceSnapshot[] {
  const rootDir = opts?.rootDir ?? DEFAULT_ROOT_DIR;
  const dir = join(rootDir, dateUtc);
  if (!existsSync(dir)) return [];

  const latestPerSource = new Map<string, { revision: number; file: string }>();
  for (const file of readdirSync(dir)) {
    const match = /^(.+?)(?:\.r(\d+))?\.json$/.exec(file);
    if (!match) continue;
    const sourceId = match[1]!;
    const revision = match[2] ? Number.parseInt(match[2], 10) : 0;
    const current = latestPerSource.get(sourceId);
    if (!current || revision > current.revision) {
      latestPerSource.set(sourceId, { revision, file });
    }
  }

  const snapshots: SourceSnapshot[] = [];
  for (const { file } of latestPerSource.values()) {
    const path = join(dir, file);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SourceSnapshot> | unknown[] | null;
    // The date directory also holds files that are not source snapshots — the AI channel's
    // write-once `ai-analyst.raw.json` (§5.13, an array of CLI/SDK events). Those have no
    // `sourceId`/`rows` and are skipped rather than failing the SHA check (found when the first
    // `decide` run crashed on the raw file left by that morning's AI step).
    if (parsed === null || Array.isArray(parsed) || typeof parsed.sourceId !== "string" || !Array.isArray(parsed.rows)) {
      continue;
    }
    const expected = sha256OfRows(parsed.rows);
    if (parsed.sha256 !== expected) {
      throw new Error(
        `Snapshot SHA-256 mismatch for "${path}": recorded ${parsed.sha256}, computed ${expected} — file was modified after being written.`,
      );
    }
    snapshots.push(parsed as SourceSnapshot);
  }
  return snapshots;
}
