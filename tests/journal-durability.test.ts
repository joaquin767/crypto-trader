import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests exercise real file I/O against an isolated temp directory (via
// process.chdir) rather than the project root, and force fresh module
// evaluations (via a cache-busting query string) so the module-load-time
// recovery logic — which normally only runs once, at process startup — can
// actually be exercised more than once. Regression coverage for spec §8.1:
// a corrupted write or an accidental delete of trade-journal.json (both have
// genuinely happened working on this codebase) must have a same-session
// recovery path instead of silently losing every open position's record.

async function freshJournalModule() {
  return import(`../src/learning/journal.ts?t=${Date.now()}-${Math.random()}`);
}

function makeSignal() {
  return {
    type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test",
    indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false },
      bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 },
      momentum: 2, atr: 100 },
  };
}
function makeResult(overrides: Record<string, unknown> = {}) {
  return { symbol: "BTC/USDT", side: "buy" as const, quantity: 0.01, price: 40000, fee: 0.4, timestamp: Date.now(), ...overrides };
}

test("persistJournal writes atomically (no .tmp left behind) and rotates backups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-durability-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const journal = await freshJournalModule();
    journal.clearJournal();
    for (let i = 0; i < 3; i++) {
      journal.recordEntry(makeSignal(), makeResult({ price: 40000 + i }), "paper");
      journal.recordExit("BTC/USDT", 41000 + i, Date.now(), 0.1);
    }
    assert(existsSync(join(dir, "trade-journal.json")), "live file must exist");
    assert(!existsSync(join(dir, "trade-journal.json.tmp")), "no .tmp file should be left behind after a successful write");
    assert(existsSync(join(dir, "trade-journal.json.bak.1")), "at least one backup generation must exist after multiple writes");
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh process recovers from a backup when the live journal file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-durability-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const journal1 = await freshJournalModule();
    journal1.clearJournal();
    journal1.recordEntry(makeSignal(), makeResult(), "paper");
    // A second write is required for a backup to exist at all — backups only
    // rotate from a *previous* live file, so the very first write in a fresh
    // directory has nothing to back up yet.
    journal1.recordEntry(makeSignal(), makeResult({ symbol: "ETH/USDT" }), "paper");
    assert.equal(journal1.getHistory().length, 2);

    // Simulate the exact accident this session hit once: the live file gets
    // deleted (e.g. an over-eager cleanup command) while a backup survives.
    unlinkSync(join(dir, "trade-journal.json"));
    assert(existsSync(join(dir, "trade-journal.json.bak.1")), "a backup must exist after the recordEntry write above");

    const journal2 = await freshJournalModule(); // simulates a restart
    // The backup reflects state as of the write BEFORE the one it backed up —
    // i.e. after the first recordEntry, before the second — so 1 trade, not 2.
    assert.equal(journal2.getHistory().length, 1, "the trade recorded before the delete must be recovered from backup");
    assert.equal(journal2.getHistory()[0].symbol, "BTC/USDT");
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh process recovers from a backup when the live journal file is corrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-durability-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const journal1 = await freshJournalModule();
    journal1.clearJournal();
    journal1.recordEntry(makeSignal(), makeResult(), "paper");
    journal1.recordEntry(makeSignal(), makeResult({ symbol: "ETH/USDT" }), "paper"); // creates a backup

    // Simulate a crash mid-write leaving the live file corrupted.
    writeFileSync(join(dir, "trade-journal.json"), "{not valid json");

    const journal2 = await freshJournalModule();
    assert.equal(journal2.getHistory().length, 1, "must recover from backup when the live file fails to parse");
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no live file and no backups, a fresh process starts with an empty journal (not an error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-durability-empty-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const journal = await freshJournalModule();
    assert.equal(journal.getHistory().length, 0);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
