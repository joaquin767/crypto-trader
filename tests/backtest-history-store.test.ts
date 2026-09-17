// History store tests — specs/daily-catalyst-manual-trading.md §5.10a "History store",
// AC-77, AC-78.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadHistory, saveHistoryFile, snapshotsAt } from "../src/backtest-daily/history-store.ts";
import type { HistoryFile } from "../src/backtest-daily/history-store.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import type { SourceRow } from "../src/research/types.ts";

const DAY = 24 * 60 * 60 * 1000;

function historyFile(overrides: Partial<HistoryFile> & Pick<HistoryFile, "sourceId" | "rows">): HistoryFile {
  return { builtAt: 0, coverage: { from: 0, to: 0 }, ...overrides };
}

// ── AC-77 ────────────────────────────────────────────────────────────────────────────────────

test("AC-77: snapshotsAt excludes a row with availableAt = T+1", () => {
  const T = Date.UTC(2026, 8, 16, 0, 15, 0);
  const rows: SourceRow[] = [
    { key: "BTC", observedFor: T, availableAt: T + 1, field: "fearGreedIndex", value: 50 },
  ];
  const [snap] = snapshotsAt([historyFile({ sourceId: "fear-greed", rows })], T);
  assert.equal(snap!.status, "unavailable"); // the only row is not yet visible
  assert.equal(snap!.statusDetail, "no history before T");
});

test("AC-77: a fear-greed history whose last visible row is 3 days old yields fetchedAt 3 days before T, marking fearGreed stale", () => {
  const T = Date.UTC(2026, 8, 16, 0, 15, 0);
  const threeDaysAgo = T - 3 * DAY;
  const rows: SourceRow[] = [
    { key: "BTC", observedFor: threeDaysAgo, availableAt: threeDaysAgo, field: "fearGreedIndex", value: 50 },
  ];
  const [snap] = snapshotsAt([historyFile({ sourceId: "fear-greed", rows })], T);
  assert.equal(snap!.status, "ok");
  assert.equal(snap!.fetchedAt, threeDaysAgo);

  const [fv] = buildFeatures([snap!], ["BTC/USDT"], T, DEFAULT_STALENESS_MS); // maxStalenessMs 26h for fear-greed
  assert.equal(fv!.features.fearGreed.kind, "missing");
  if (fv!.features.fearGreed.kind === "missing") assert.equal(fv!.features.fearGreed.reason, "stale");
});

// ── AC-78 ────────────────────────────────────────────────────────────────────────────────────

test("AC-78: a Farside row for US trading day 2025-03-03 (availableAt D+1 12:00Z) is invisible at 2025-03-04T00:15Z and visible at 2025-03-05T00:15Z", () => {
  const observedFor = Date.UTC(2025, 2, 3);
  const availableAt = Date.UTC(2025, 2, 4, 12, 0, 0);
  const rows: SourceRow[] = [{ key: "BTC", observedFor, availableAt, field: "netFlowUsd", value: 123 }];
  const file = historyFile({ sourceId: "farside-btc-etf", rows });

  const notYet = Date.UTC(2025, 2, 4, 0, 15, 0);
  const [snapNotYet] = snapshotsAt([file], notYet);
  assert.equal(snapNotYet!.status, "unavailable");

  const later = Date.UTC(2025, 2, 5, 0, 15, 0);
  const [snapLater] = snapshotsAt([file], later);
  assert.equal(snapLater!.status, "ok");
  assert.equal(snapLater!.rows.length, 1);
});

// ── manual sources: synthesized _meta asOf row ──────────────────────────────────────────────

test("snapshotsAt synthesizes a _meta asOf row for macro-calendar-manual equal to T's UTC date", () => {
  const T = Date.UTC(2026, 8, 16, 0, 15, 0);
  const rows: SourceRow[] = [
    { key: "FOMC", observedFor: T + 10 * DAY, availableAt: T - 100 * DAY, field: "eventTime", value: "x" },
  ];
  const [snap] = snapshotsAt([historyFile({ sourceId: "macro-calendar-manual", rows })], T);
  assert.equal(snap!.status, "ok");
  const meta = snap!.rows.find((r) => r.key === "_meta" && r.field === "asOf");
  assert.ok(meta);
  assert.equal(meta!.value, "2026-09-16");
});

test("snapshotsAt on an unlocks-manual file with no visible unlocks is still ok (meta row present)", () => {
  const T = Date.UTC(2026, 8, 16, 0, 15, 0);
  const [snap] = snapshotsAt([historyFile({ sourceId: "unlocks-manual", rows: [] })], T);
  assert.equal(snap!.status, "ok");
  assert.equal(snap!.rows.length, 1); // just the synthesized meta row
});

// ── loadHistory / saveHistoryFile ────────────────────────────────────────────────────────────

test("saveHistoryFile writes atomically and loadHistory reads it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-store-test-"));
  try {
    const file = historyFile({
      sourceId: "bybit-klines-1d",
      rows: [{ key: "BTC/USDT", observedFor: 0, availableAt: DAY, field: "close", value: 100 }],
    });
    saveHistoryFile(dir, file);
    const loaded = loadHistory(dir);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHistory throws (naming the file) on an unparseable history file", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-store-test-"));
  try {
    saveHistoryFile(dir, historyFile({ sourceId: "fear-greed", rows: [] }));
    // Corrupt it after the fact.
    const path = join(dir, "fear-greed.json");
    writeFileSync(path, "{not json");
    assert.throws(() => loadHistory(dir), /fear-greed\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHistory returns an empty array for a missing directory", () => {
  const missing = join(tmpdir(), "history-store-test-does-not-exist-12345");
  assert.deepEqual(loadHistory(missing), []);
});
