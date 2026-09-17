// AI usage/cost ledger tests — specs/daily-catalyst-manual-trading.md §5.13, §4.18.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLedgerLine, estimateCallCostUsd, monthToDateSpendUsd } from "../src/research/ai/budget.ts";

test("monthToDateSpendUsd: missing file -> 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-budget-test-"));
  try {
    assert.equal(monthToDateSpendUsd(join(dir, "nope.jsonl"), Date.UTC(2026, 8, 16)), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("monthToDateSpendUsd: sums only lines whose time falls in now's UTC month", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-budget-test-"));
  try {
    const path = join(dir, "ai-usage.jsonl");
    const lines = [
      { time: Date.UTC(2026, 7, 31, 23, 59), dateUtc: "2026-08-31", model: "m", usage: { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 }, costUsd: 100, resultKind: "ok" },
      { time: Date.UTC(2026, 8, 1, 0, 0), dateUtc: "2026-09-01", model: "m", usage: { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 }, costUsd: 1, resultKind: "ok" },
      { time: Date.UTC(2026, 8, 16, 0, 0), dateUtc: "2026-09-16", model: "m", usage: { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 }, costUsd: 2.5, resultKind: "failed" },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    assert.equal(monthToDateSpendUsd(path, Date.UTC(2026, 8, 16, 12)), 3.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("monthToDateSpendUsd: an unparseable line throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-budget-test-"));
  try {
    const path = join(dir, "ai-usage.jsonl");
    writeFileSync(path, "not json\n");
    assert.throws(() => monthToDateSpendUsd(path, Date.now()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateCallCostUsd combines input/output token pricing and per-search cost", () => {
  const cfg = { inputUsdPerMTok: 5, outputUsdPerMTok: 25, webSearchUsdPerRequest: 0.01 };
  const usage = { inputTokens: 1_000_000, outputTokens: 200_000, webSearchRequests: 3 };
  // 1 * 5 + 0.2 * 25 + 3 * 0.01 = 5 + 5 + 0.03
  assert.ok(Math.abs(estimateCallCostUsd(usage, cfg) - 10.03) < 1e-9);
});

test("appendLedgerLine creates the parent directory and appends without truncating", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-budget-test-"));
  try {
    const path = join(dir, "nested", "ai-usage.jsonl");
    const entry = { time: 1, dateUtc: "2026-09-16", model: "m", usage: { inputTokens: 1, outputTokens: 1, webSearchRequests: 0 }, costUsd: 0.01, listCostUsd: 0.01, resultKind: "ok" as const };
    appendLedgerLine(path, entry);
    appendLedgerLine(path, { ...entry, time: 2 });
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
