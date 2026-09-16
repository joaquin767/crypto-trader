// Manual journal tests — specs/daily-catalyst-manual-trading.md §5.7, AC-35, AC-67.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JournalUnreadableError, linkTradeToPlan, loadManualJournal, recordPaperEntry, recordPaperExit, saveManualJournal,
} from "../src/journal/manual-journal.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import type { TradePlan } from "../src/research/planner.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "manual-journal-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function samplePlan(overrides: Partial<Extract<TradePlan, { kind: "plan" }>> = {}): Extract<TradePlan, { kind: "plan" }> {
  return {
    kind: "plan", planId: "2026-09-16:test-rule:BTC/USDT", ruleId: "test-rule", ruleHash: "hash",
    origin: "rules-file", symbol: "BTC/USDT", side: "long",
    referencePrice: 100, stopPrice: 90, targetPrice: 130, expiresAt: 0,
    quantity: 1, notionalUsd: 100, riskUsd: 10, leverage: 2, marginUsd: 50,
    estLiquidationPrice: 50.5, liqToStopRatio: 2, estRoundTripFeeUsd: 0.11,
    venueIntent: "paper", maxHoldDays: 5,
    ...overrides,
  };
}

function sampleTrade(overrides: Partial<ManualTrade> = {}): ManualTrade {
  return {
    id: "t1", venue: "bybit-live", symbol: "BTC/USDT", side: "long",
    planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [], exitFills: [], actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

// ── loadManualJournal / saveManualJournal (AC-35) ──────────────────────────────────────────────

test("loadManualJournal returns [] when the file doesn't exist", () => {
  withTempDir((dir) => {
    const path = join(dir, "manual-journal.json");
    assert.deepEqual(loadManualJournal({ path }), []);
  });
});

test("saveManualJournal writes an atomic file readable by loadManualJournal", () => {
  withTempDir((dir) => {
    const path = join(dir, "manual-journal.json");
    const trades = [sampleTrade()];
    saveManualJournal(trades, { path });
    assert.deepEqual(loadManualJournal({ path }), trades);
    assert.ok(!existsSync(`${path}.tmp`));
  });
});

test("saveManualJournal rotates up to 5 backups", () => {
  withTempDir((dir) => {
    const path = join(dir, "manual-journal.json");
    for (let n = 0; n < 7; n++) {
      saveManualJournal([sampleTrade({ id: `t${n}` })], { path });
    }
    assert.deepEqual(loadManualJournal({ path }), [sampleTrade({ id: "t6" })]);
    assert.deepEqual(JSON.parse(readFileSync(`${path}.bak.1`, "utf-8")), [sampleTrade({ id: "t5" })]);
    assert.deepEqual(JSON.parse(readFileSync(`${path}.bak.5`, "utf-8")), [sampleTrade({ id: "t1" })]);
    assert.ok(!existsSync(`${path}.bak.6`));
  });
});

test("AC-35: a corrupted live file falls back to a valid .bak.1", () => {
  withTempDir((dir) => {
    const path = join(dir, "manual-journal.json");
    writeFileSync(path, "not json");
    writeFileSync(`${path}.bak.1`, JSON.stringify([sampleTrade({ id: "recovered" })]));
    const trades = loadManualJournal({ path });
    assert.deepEqual(trades, [sampleTrade({ id: "recovered" })]);
  });
});

test("AC-35: all 6 files corrupt throws JournalUnreadableError", () => {
  withTempDir((dir) => {
    const path = join(dir, "manual-journal.json");
    writeFileSync(path, "not json");
    for (let n = 1; n <= 5; n++) writeFileSync(`${path}.bak.${n}`, "still not json");
    assert.throws(() => loadManualJournal({ path }), JournalUnreadableError);
  });
});

// ── linkTradeToPlan ─────────────────────────────────────────────────────────────────────────────

test("linkTradeToPlan sets planId/ruleId/ruleHash/plannedSnapshot/aiStanceAtPlan", () => {
  const trade = sampleTrade();
  const plan = samplePlan();
  const linked = linkTradeToPlan(trade, plan, "support", 123);
  assert.equal(linked.planId, plan.planId);
  assert.equal(linked.ruleId, plan.ruleId);
  assert.equal(linked.ruleHash, plan.ruleHash);
  assert.deepEqual(linked.plannedSnapshot, plan);
  assert.equal(linked.aiStanceAtPlan, "support");
  assert.equal(linked.updatedAt, 123);
});

// ── recordPaperEntry / recordPaperExit (AC-67) ─────────────────────────────────────────────────

test("AC-67: paper entry at 100 and exit at 110 for quantity 1, roundTripFeePercent 0.11", () => {
  const plan = samplePlan({ quantity: 1, notionalUsd: 100, estRoundTripFeeUsd: 0.11, referencePrice: 100 });
  const trade = recordPaperEntry(plan, null, 100, 1000);
  assert.equal(trade.venue, "paper");
  assert.equal(trade.status, "open");
  assert.equal(trade.entryFills.length, 1);
  assert.equal(trade.entryFills[0]!.qty, 1);
  assert.ok(Math.abs(trade.entryFills[0]!.feeUsd - 0.055) < 1e-9);

  const closed = recordPaperExit(trade, 110, 2000, "target");
  assert.equal(closed.status, "closed");
  assert.equal(closed.exitKind, "target");
  assert.equal(closed.exitFills.length, 1);
  assert.ok(Math.abs(closed.exitFills[0]!.feeUsd - 0.0605) < 1e-9);

  const grossPnl = closed.exitFills[0]!.qty * closed.exitFills[0]!.price - closed.entryFills[0]!.qty * closed.entryFills[0]!.price;
  const fees = closed.entryFills[0]!.feeUsd + closed.exitFills[0]!.feeUsd;
  const netPnlUsd = grossPnl - fees + closed.fundingUsd;
  assert.ok(Math.abs(netPnlUsd - 9.8845) < 1e-9, `expected 9.8845, got ${netPnlUsd}`);
});

test("recordPaperEntry/recordPaperExit: fills carry the correct buy/sell side per plan side", () => {
  const longPlan = samplePlan({ side: "long" });
  const longTrade = recordPaperExit(recordPaperEntry(longPlan, null, 100, 0), 110, 1, "target");
  assert.equal(longTrade.entryFills[0]!.side, "buy");
  assert.equal(longTrade.exitFills[0]!.side, "sell");

  const shortPlan = samplePlan({ side: "short" });
  const shortTrade = recordPaperEntry(shortPlan, null, 100, 0);
  assert.equal(shortTrade.side, "short");
  assert.equal(shortTrade.entryFills[0]!.side, "sell");
  const shortClosed = recordPaperExit(shortTrade, 90, 1, "target");
  assert.equal(shortClosed.exitFills[0]!.side, "buy");
});
