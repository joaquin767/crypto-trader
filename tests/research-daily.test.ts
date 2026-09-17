// research:daily CLI tests — specs/daily-catalyst-manual-trading.md §5.12, AC-18.
// No test touches the network: every adapter's `fetch` dependency is a stub that always fails,
// so every source resolves to "unavailable" deterministically (features end up "missing",
// completeness "incomplete") without needing per-endpoint fixtures — this file exercises the
// CLI's own orchestration (exit codes, revisioning, rule-set validation gate), not the
// adapters/features/planner logic already covered by their own test files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterDeps } from "../src/research/http.ts";
import {
  decideResearchDailyAction, latestReportRevision, parseResearchDailyArgs, runResearchDaily,
} from "../scripts/research-daily.ts";
import type { ResearchDailyArgs } from "../scripts/research-daily.ts";

const NOW = Date.UTC(2026, 8, 16, 1, 0, 0); // 2026-09-16T01:00:00Z — after the 00:15 decision time

const VALID_RULES = {
  schemaVersion: 1,
  rules: [
    {
      id: "test-rule", version: 1, description: "d", evidence: ["X1"], status: "experimental",
      symbols: ["BTC/USDT"], side: "long",
      entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
      stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
    },
  ],
};

function fakeDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    fetch: (async () => { throw new Error("stub network error"); }) as unknown as typeof fetch,
    now: () => NOW,
    sleep: async () => {},
    readFile: () => { throw new Error("unexpected readFile call"); },
    statMtimeMs: () => NOW,
    fileExists: () => false,
    ...overrides,
  };
}

function writeTempConfig(dir: string): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    exchange: "bybit", apiKey: "k", apiSecret: "s", symbols: ["BTC/USDT"],
    maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 10,
    stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  }));
  return path;
}

function makeArgs(dir: string, overrides: Partial<ResearchDailyArgs> = {}): ResearchDailyArgs {
  return {
    date: "2026-09-16",
    refetch: false,
    configPath: writeTempConfig(dir),
    snapshotRoot: join(dir, "snapshots"),
    reportsRoot: join(dir, "reports"),
    rulesPath: join(dir, "research-rules.json"),
    noAi: false,
    ...overrides,
  };
}

// ── parseResearchDailyArgs ──────────────────────────────────────────────────────────────────

test("parseResearchDailyArgs: defaults", () => {
  const args = parseResearchDailyArgs([], NOW);
  assert.equal(args.date, "2026-09-16");
  assert.equal(args.refetch, false);
  assert.equal(args.configPath, "./config.json");
  assert.equal(args.snapshotRoot, "data/snapshots");
  assert.equal(args.reportsRoot, "reports");
  assert.equal(args.rulesPath, "./research-rules.json");
  assert.equal(args.noAi, false);
});

test("parseResearchDailyArgs: reads flags", () => {
  const args = parseResearchDailyArgs(
    ["--date", "2026-01-01", "--refetch", "--no-ai", "--snapshot-root", "/tmp/s", "--reports-root", "/tmp/r", "--rules-path", "/tmp/rules.json"],
    NOW,
  );
  assert.equal(args.date, "2026-01-01");
  assert.equal(args.refetch, true);
  assert.equal(args.noAi, true);
  assert.equal(args.snapshotRoot, "/tmp/s");
  assert.equal(args.reportsRoot, "/tmp/r");
  assert.equal(args.rulesPath, "/tmp/rules.json");
});

// ── decideResearchDailyAction / latestReportRevision ───────────────────────────────────────

test("exit 4: decision time in the future", () => {
  const decision = decideResearchDailyAction({ date: "2026-09-17", refetch: false }, NOW, -1);
  assert.deepEqual(decision.kind, "exit");
  if (decision.kind === "exit") assert.equal(decision.code, 4);
});

test("exit 3: a report already exists and --refetch was not given", () => {
  const decision = decideResearchDailyAction({ date: "2026-09-16", refetch: false }, NOW, 0);
  assert.deepEqual(decision.kind, "exit");
  if (decision.kind === "exit") assert.equal(decision.code, 3);
});

test("proceeds with revision 0 when nothing exists, revision N+1 when refetching", () => {
  const fresh = decideResearchDailyAction({ date: "2026-09-16", refetch: false }, NOW, -1);
  assert.equal(fresh.kind, "proceed");
  if (fresh.kind === "proceed") assert.equal(fresh.revision, 0);

  const refetch = decideResearchDailyAction({ date: "2026-09-16", refetch: true }, NOW, 2);
  assert.equal(refetch.kind, "proceed");
  if (refetch.kind === "proceed") assert.equal(refetch.revision, 3);
});

test("latestReportRevision: -1 when the directory doesn't exist or has no matching file", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    assert.equal(latestReportRevision(join(dir, "nope"), "2026-09-16"), -1);
    assert.equal(latestReportRevision(dir, "2026-09-16"), -1);
    writeFileSync(join(dir, "2026-09-16.json"), "{}");
    assert.equal(latestReportRevision(dir, "2026-09-16"), 0);
    writeFileSync(join(dir, "2026-09-16.r1.json"), "{}");
    assert.equal(latestReportRevision(dir, "2026-09-16"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runResearchDaily: full pipeline (network stubbed to always fail) ───────────────────────

test("runResearchDaily writes a report (exit 0) even when every source is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report);
    assert.equal(result.report!.completeness, "incomplete");
    assert.ok(existsSync(join(args.reportsRoot, "2026-09-16.json")));
    assert.ok(existsSync(join(args.reportsRoot, "2026-09-16.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-18: running twice without --refetch exits 3 the second time and leaves the file unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const first = await runResearchDaily(args, deps);
    assert.equal(first.exitCode, 0);
    const jsonPath = join(args.reportsRoot, "2026-09-16.json");
    const bytesBefore = readFileSync(jsonPath, "utf-8");

    const second = await runResearchDaily(args, deps);
    assert.equal(second.exitCode, 3);
    assert.equal(readFileSync(jsonPath, "utf-8"), bytesBefore);

    // --refetch writes a new revision instead of overwriting
    const third = await runResearchDaily({ ...args, refetch: true }, deps);
    assert.equal(third.exitCode, 0);
    assert.ok(existsSync(join(args.reportsRoot, "2026-09-16.r1.json")));
    assert.equal(readFileSync(jsonPath, "utf-8"), bytesBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exit 2: invalid research-rules.json prints all issues and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const invalidRules = { schemaVersion: 2, rules: [] }; // wrong schemaVersion -> 1 issue
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(invalidRules) : (() => { throw new Error("unexpected path"); })()) });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 2);
    assert.ok(result.message?.includes("schemaVersion"));
    assert.ok(!existsSync(join(args.reportsRoot, "2026-09-16.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exit 2: a rule referencing a symbol outside config.symbols fails validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const badRules = {
      schemaVersion: 1,
      rules: [{ ...VALID_RULES.rules[0], symbols: ["NOT/CONFIGURED"] }],
    };
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(badRules) : (() => { throw new Error("unexpected path"); })()) });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
