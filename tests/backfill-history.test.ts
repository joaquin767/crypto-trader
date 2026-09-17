// backfill-history CLI tests — specs/daily-catalyst-manual-trading.md §5.16 item 1, AC-127.
// No test touches the network: the fetch dependency is a stub; other sources' fetch calls
// (bybit klines/funding/instruments, defillama, fear-greed, fred) are left to fail, which
// backfill-history.ts's own contract already treats as a non-fatal per-source failure — this
// file exercises only the new coinalyze-oi backfill path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBackfill } from "../scripts/backfill-history.ts";
import type { AdapterDeps } from "../src/research/http.ts";
import type { HistoryFile } from "../src/backtest-daily/history-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "research", "coinalyze-oi-history-response.json");

const NOW = Date.UTC(2026, 8, 16, 0, 15, 0);

function writeConfig(dir: string): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    exchange: "bybit", apiKey: "k", apiSecret: "s", symbols: ["BTC/USDT"],
    maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 10,
    stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  }));
  return path;
}

// `await fn()` (not `return fn()`) matters: runBackfill awaits several other sources' fetches
// before it ever reaches coinalyze-oi, so the env var must stay set across all of those awaits,
// not just until fn() returns its (still-pending) promise.
async function withCoinalyzeKey<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["COINALYZE_API_KEY"];
  if (key === undefined) delete process.env["COINALYZE_API_KEY"];
  else process.env["COINALYZE_API_KEY"] = key;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["COINALYZE_API_KEY"];
    else process.env["COINALYZE_API_KEY"] = prev;
  }
}

test("AC-127: coinalyze-oi backfill rows carry the same day-close + 1h lag as the live adapter", async () => {
  await withCoinalyzeKey("test-key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-coinalyze-"));
    try {
      const configPath = writeConfig(dir);
      const historyDir = join(dir, "history");
      const fixtureBody = readFileSync(FIXTURE, "utf-8");
      const deps: AdapterDeps = {
        fetch: (async (url: unknown) => {
          if (String(url).includes("coinalyze.net")) return new Response(fixtureBody, { status: 200 });
          throw new Error("stub network error"); // every other source: reported as a failure, never fatal
        }) as unknown as typeof fetch,
        now: () => NOW,
        sleep: async () => {},
        readFile: () => { throw new Error("no manual file in this test"); },
        statMtimeMs: () => NOW,
        fileExists: () => false,
      };

      const summaries = await runBackfill({ from: "2026-09-10", to: "2026-09-14", historyDir, configPath }, deps);
      const summary = summaries.find((s) => s.sourceId === "coinalyze-oi");
      assert.ok(summary, "coinalyze-oi summary missing");
      assert.equal(summary!.failure, null);
      assert.equal(summary!.rows, 5);

      const file = JSON.parse(readFileSync(join(historyDir, "coinalyze-oi.json"), "utf-8")) as HistoryFile;
      assert.equal(file.sourceId, "coinalyze-oi");
      const row = file.rows.find((r) => r.key === "BTC/USDT" && r.observedFor === 1_788_998_400_000);
      assert.ok(row, "expected row for the fixture's first candle");
      assert.equal(row!.value, 100500);
      assert.equal(row!.availableAt, row!.observedFor + 25 * 60 * 60 * 1000);

      // Every other source failed its fetch stub but the run as a whole still completed and
      // reported a per-source failure, never throwing — the header comment's contract.
      const bybitKlines = summaries.find((s) => s.sourceId === "bybit-klines-1d");
      assert.ok(bybitKlines?.failure);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("AC-127: missing COINALYZE_API_KEY records zero rows and a failure, without blocking other sources", async () => {
  await withCoinalyzeKey(undefined, async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-coinalyze-nokey-"));
    try {
      const configPath = writeConfig(dir);
      const historyDir = join(dir, "history");
      const deps: AdapterDeps = {
        fetch: (async () => { throw new Error("stub network error"); }) as unknown as typeof fetch,
        now: () => NOW,
        sleep: async () => {},
        readFile: () => { throw new Error("no manual file in this test"); },
        statMtimeMs: () => NOW,
        fileExists: () => false,
      };
      const summaries = await runBackfill({ from: "2026-09-10", to: "2026-09-14", historyDir, configPath }, deps);
      const summary = summaries.find((s) => s.sourceId === "coinalyze-oi");
      assert.ok(summary);
      assert.equal(summary!.rows, 0);
      assert.match(summary!.failure ?? "", /COINALYZE_API_KEY not set/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a failed source never overwrites history that was already backfilled", async () => {
  await withCoinalyzeKey("test-key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-keep-"));
    try {
      const configPath = writeConfig(dir);
      const historyDir = join(dir, "history");
      mkdirSync(historyDir, { recursive: true });
      // A previously backfilled multi-year file for a source whose fetch will fail this run.
      const previous = {
        sourceId: "defillama-stablecoins",
        builtAt: NOW - 86_400_000,
        coverage: { from: Date.UTC(2024, 0, 1), to: Date.UTC(2026, 8, 15) },
        rows: [
          { key: "total", observedFor: Date.UTC(2026, 8, 14), availableAt: Date.UTC(2026, 8, 14), field: "totalCirculatingUsd", value: 100 },
          { key: "total", observedFor: Date.UTC(2026, 8, 15), availableAt: Date.UTC(2026, 8, 15), field: "totalCirculatingUsd", value: 101 },
        ],
      };
      writeFileSync(join(historyDir, "defillama-stablecoins.json"), JSON.stringify(previous, null, 2));

      const deps: AdapterDeps = {
        // Every network source fails this run (the real case was a transient abort on defillama).
        fetch: (async () => { throw new Error("stub network error"); }) as unknown as typeof fetch,
        now: () => NOW,
        sleep: async () => {},
        readFile: () => { throw new Error("no manual file in this test"); },
        statMtimeMs: () => NOW,
        fileExists: () => false,
      };

      const summaries = await runBackfill({ from: "2026-09-10", to: "2026-09-14", historyDir, configPath }, deps);
      const summary = summaries.find((s) => s.sourceId === "defillama-stablecoins");
      assert.ok(summary?.failure, "expected a reported failure for the stubbed source");
      assert.equal(summary!.rows, 2, "the summary reports the kept rows, not 0");
      assert.equal(summary!.coverage, "kept previous file");

      const onDisk = JSON.parse(readFileSync(join(historyDir, "defillama-stablecoins.json"), "utf-8")) as HistoryFile;
      assert.equal(onDisk.rows.length, 2, "the previous history file must survive a failed build");
      assert.equal(onDisk.builtAt, previous.builtAt, "and must not be rewritten at all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
