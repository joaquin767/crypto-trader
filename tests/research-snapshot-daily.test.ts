// scripts/snapshot-daily.ts exit-code logic — specs/daily-catalyst-manual-trading.md §5.12/§7.
// Exercises decideSnapshotAction/parseSnapshotDailyArgs directly so the CLI's exit-3/exit-4
// behavior is testable without spawning a process.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideSnapshotAction, parseSnapshotDailyArgs, resolveDecisionTime } from "../scripts/snapshot-daily.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import type { SourceSnapshot } from "../src/research/types.ts";

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0); // 2026-09-16T12:00:00Z
const SCHEDULED = Date.UTC(2026, 8, 16, 0, 15, 0);

test("AC-1b: live run — all fetches within 2h after 00:15 → decision time is the last fetchedAt", () => {
  const r = resolveDecisionTime(SCHEDULED, [SCHEDULED + 3_000, SCHEDULED + 41_000, SCHEDULED + 9_000]);
  assert.deepEqual(r, { decisionTime: SCHEDULED + 41_000, mode: "live" });
});

test("AC-1b: late or backdated run — any fetch outside the window → scheduled decision time stands", () => {
  assert.deepEqual(resolveDecisionTime(SCHEDULED, [SCHEDULED + 3_000, SCHEDULED + 3 * 3_600_000]), { decisionTime: SCHEDULED, mode: "scheduled" });
  assert.deepEqual(resolveDecisionTime(SCHEDULED, []), { decisionTime: SCHEDULED, mode: "scheduled" });
});

test("AC-1b: a fetchedAt-available source fetched seconds after 00:15 is usable in a live run", () => {
  const fetchedAt = SCHEDULED + 20_000;
  const snap: SourceSnapshot = {
    sourceId: "fear-greed", fetchedAt, status: "ok", statusDetail: "", sha256: "x",
    rows: [{ key: "BTC", observedFor: Date.UTC(2026, 8, 16), availableAt: fetchedAt, value: 42, field: "fearGreedIndex" }],
  };
  const { decisionTime } = resolveDecisionTime(SCHEDULED, [fetchedAt]);
  const live = buildFeatures([snap], ["BTC/USDT"], decisionTime, DEFAULT_STALENESS_MS)[0]!.features.fearGreed;
  const scheduled = buildFeatures([snap], ["BTC/USDT"], SCHEDULED, DEFAULT_STALENESS_MS)[0]!.features.fearGreed;
  assert.equal(live.kind, "value");
  assert.equal(scheduled.kind, "missing");
});

test("parseSnapshotDailyArgs: defaults date to today UTC and revision to 0/not-provided", () => {
  const args = parseSnapshotDailyArgs([], NOW);
  assert.equal(args.date, "2026-09-16");
  assert.equal(args.revision, 0);
  assert.equal(args.revisionProvided, false);
  assert.equal(args.configPath, "./config.json");
  assert.equal(args.snapshotRoot, "data/snapshots");
});

test("parseSnapshotDailyArgs: reads --date, --revision, --config, --snapshot-root", () => {
  const args = parseSnapshotDailyArgs(
    ["--date", "2026-09-01", "--revision", "2", "--config", "/tmp/c.json", "--snapshot-root", "/tmp/snaps"],
    NOW,
  );
  assert.equal(args.date, "2026-09-01");
  assert.equal(args.revision, 2);
  assert.equal(args.revisionProvided, true);
  assert.equal(args.configPath, "/tmp/c.json");
  assert.equal(args.snapshotRoot, "/tmp/snaps");
});

test("exit 4: decision time in the future", () => {
  const decision = decideSnapshotAction({ date: "2026-09-17", revision: 0, revisionProvided: false }, NOW, false);
  assert.deepEqual(decision.kind, "exit");
  if (decision.kind === "exit") assert.equal(decision.code, 4);
});

test("exit 3: snapshots already exist for the date and no --revision given", () => {
  const decision = decideSnapshotAction({ date: "2026-09-16", revision: 0, revisionProvided: false }, NOW, true);
  assert.deepEqual(decision.kind, "exit");
  if (decision.kind === "exit") assert.equal(decision.code, 3);
});

test("proceeds when snapshots exist but --revision was explicitly given", () => {
  const decision = decideSnapshotAction({ date: "2026-09-16", revision: 1, revisionProvided: true }, NOW, true);
  assert.equal(decision.kind, "proceed");
  if (decision.kind === "proceed") assert.equal(decision.decisionTime, Date.parse("2026-09-16T00:15:00Z"));
});

test("proceeds for today's date once past 00:15 UTC with no prior snapshots", () => {
  const decision = decideSnapshotAction({ date: "2026-09-16", revision: 0, revisionProvided: false }, NOW, false);
  assert.equal(decision.kind, "proceed");
});

test("exit 4: an unparseable --date", () => {
  const decision = decideSnapshotAction({ date: "not-a-date", revision: 0, revisionProvided: false }, NOW, false);
  assert.deepEqual(decision.kind, "exit");
  if (decision.kind === "exit") assert.equal(decision.code, 4);
});
