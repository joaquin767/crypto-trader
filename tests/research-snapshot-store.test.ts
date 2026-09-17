// AC-4, AC-5 — specs/daily-catalyst-manual-trading.md §5.2/§6.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSnapshots, SnapshotExistsError, writeSnapshot } from "../src/research/snapshot-store.ts";
import type { SourceSnapshot } from "../src/research/types.ts";

function fixtureSnapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    sourceId: "fear-greed",
    fetchedAt: 1_700_000_000_000,
    status: "ok",
    statusDetail: "",
    rows: [{ key: "BTC", observedFor: 1_700_000_000_000, availableAt: 1_700_000_000_000, value: 55, field: "fearGreedIndex" }],
    sha256: "placeholder-overwritten-by-writeSnapshot",
    ...overrides,
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-store-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("AC-4: writing the same date/source twice without a revision throws SnapshotExistsError and leaves the file unchanged", () => {
  withTempDir((dir) => {
    const snap = fixtureSnapshot();
    const path = writeSnapshot("2026-09-16", snap, { rootDir: dir });
    const before = readFileSync(path, "utf-8");

    assert.throws(() => writeSnapshot("2026-09-16", { ...snap, statusDetail: "different" }, { rootDir: dir }), SnapshotExistsError);

    const after = readFileSync(path, "utf-8");
    assert.equal(after, before, "file bytes must be unchanged after a rejected write");
  });
});

test("a revision > 0 writes a separate .r<revision>.json file, itself write-once", () => {
  withTempDir((dir) => {
    const snap = fixtureSnapshot();
    writeSnapshot("2026-09-16", snap, { rootDir: dir });
    const revPath = writeSnapshot("2026-09-16", snap, { rootDir: dir, revision: 1 });
    assert.match(revPath, /fear-greed\.r1\.json$/);
    assert.throws(() => writeSnapshot("2026-09-16", snap, { rootDir: dir, revision: 1 }), SnapshotExistsError);
  });
});

test("AC-5: a snapshot file edited on disk fails SHA-256 verification on read", () => {
  withTempDir((dir) => {
    const path = writeSnapshot("2026-09-16", fixtureSnapshot(), { rootDir: dir });
    const record = JSON.parse(readFileSync(path, "utf-8"));
    record.rows.push({ key: "ETH", observedFor: 0, availableAt: 0, value: 1, field: "tampered" });
    writeFileSync(path, JSON.stringify(record, null, 2));

    assert.throws(() => readSnapshots("2026-09-16", { rootDir: dir }), /SHA-256 mismatch/);
  });
});

test("readSnapshots returns [] for a date with no directory", () => {
  withTempDir((dir) => {
    assert.deepEqual(readSnapshots("2099-01-01", { rootDir: dir }), []);
  });
});

test("readSnapshots returns the latest revision per source", () => {
  withTempDir((dir) => {
    const snap = fixtureSnapshot();
    writeSnapshot("2026-09-16", snap, { rootDir: dir });
    writeSnapshot("2026-09-16", { ...snap, statusDetail: "rev1" }, { rootDir: dir, revision: 1 });
    writeSnapshot("2026-09-16", { ...snap, statusDetail: "rev2" }, { rootDir: dir, revision: 2 });

    const result = readSnapshots("2026-09-16", { rootDir: dir });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.statusDetail, "rev2");
  });
});

test("readSnapshots ignores non-snapshot files in the date directory (the AI channel's ai-analyst.raw.json)", () => {
  withTempDir((dir) => {
    const snap = fixtureSnapshot();
    writeSnapshot("2026-09-16", snap, { rootDir: dir });
    // §5.13 puts the AI channel's raw response next to the snapshots: an array of events, no rows.
    writeFileSync(join(dir, "2026-09-16", "ai-analyst.raw.json"), JSON.stringify([{ type: "system" }, { type: "result" }]));
    writeFileSync(join(dir, "2026-09-16", "notes.json"), JSON.stringify({ hello: "world" }));

    const result = readSnapshots("2026-09-16", { rootDir: dir });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.sourceId, snap.sourceId);
  });
});

test("writeSnapshot computes sha256 of JSON.stringify(rows) itself, ignoring a caller-supplied value", () => {
  withTempDir((dir) => {
    const snap = fixtureSnapshot({ sha256: "totally-wrong" });
    const path = writeSnapshot("2026-09-16", snap, { rootDir: dir });
    const record = JSON.parse(readFileSync(path, "utf-8")) as SourceSnapshot;
    assert.notEqual(record.sha256, "totally-wrong");
    // readSnapshots would throw if the recorded hash didn't match JSON.stringify(rows).
    assert.deepEqual(readSnapshots("2026-09-16", { rootDir: dir })[0]!.rows, snap.rows);
  });
});
