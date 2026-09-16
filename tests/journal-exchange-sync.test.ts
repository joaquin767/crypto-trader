// Exchange sync tests — specs/daily-catalyst-manual-trading.md §5.8/§5.8a,
// AC-27, AC-28, AC-55..60, AC-61, AC-63b.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertReadOnlyKey, reconstructTrades, syncFromExchange, TradePermissionKeyError,
} from "../src/journal/exchange-sync.ts";
import type { RawExecution } from "../src/journal/exchange-sync.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import type { RestClient } from "../src/bybit/rest.ts";
import type { TradePlan } from "../src/research/planner.ts";

type FakeRest = {
  getApiKeyInfo: () => Promise<{ readOnly: 0 | 1; permissions: Record<string, string[]> }>;
  getExecutions: (category: string, symbol: string, startTime: number, endTime: number, cursor?: string) => Promise<{ list: unknown[]; nextPageCursor: string }>;
  getFundingExecutions: (category: string, symbol: string, startTime: number, endTime: number, cursor?: string) => Promise<{ list: unknown[]; nextPageCursor: string }>;
  getPositions: (category: string) => Promise<{ list: unknown[] }>;
};

function fakeRest(overrides: Partial<FakeRest> = {}): RestClient {
  const base: FakeRest = {
    getApiKeyInfo: async () => ({ readOnly: 1, permissions: {} }),
    getExecutions: async () => ({ list: [], nextPageCursor: "" }),
    getFundingExecutions: async () => ({ list: [], nextPageCursor: "" }),
    getPositions: async () => ({ list: [] }),
  };
  return { ...base, ...overrides } as unknown as RestClient;
}

function rawExec(execId: string, symbol: string, side: "buy" | "sell", price: number, qty: number, time: number, execType: "Trade" | "BustTrade" = "Trade", feeUsd = 0, closedSize = 0): RawExecution {
  return { execId, symbol, side, price, qty, feeUsd, time, execType, closedSize };
}

// ── assertReadOnlyKey (AC-27) ────────────────────────────────────────────────────────────────────

test("AC-27: readOnly: 0 throws TradePermissionKeyError", async () => {
  const rest = fakeRest({ getApiKeyInfo: async () => ({ readOnly: 0, permissions: {} }) });
  await assert.rejects(() => assertReadOnlyKey(rest), TradePermissionKeyError);
});

test("assertReadOnlyKey: readOnly 1 with a Withdraw permission still throws", async () => {
  const rest = fakeRest({ getApiKeyInfo: async () => ({ readOnly: 1, permissions: { Wallet: ["Withdraw"] } }) });
  await assert.rejects(() => assertReadOnlyKey(rest), TradePermissionKeyError);
});

test("assertReadOnlyKey: readOnly 1 with no Withdraw permission resolves", async () => {
  const rest = fakeRest({ getApiKeyInfo: async () => ({ readOnly: 1, permissions: { Wallet: ["Read"] } }) });
  await assert.doesNotReject(() => assertReadOnlyKey(rest));
});

test("assertReadOnlyKey: a network failure also throws (fail closed)", async () => {
  const rest = fakeRest({ getApiKeyInfo: async () => { throw new Error("network down"); } });
  await assert.rejects(() => assertReadOnlyKey(rest), TradePermissionKeyError);
});

// ── reconstructTrades (AC-55, AC-56, AC-57, AC-58, AC-61, AC-63b) ────────────────────────────────

test("AC-55: buy 1@100, buy 1@110, sell 2@120 closes one trade with avgEntry 105", () => {
  const execs = [
    rawExec("e1", "BTC/USDT", "buy", 100, 1, 1000),
    rawExec("e2", "BTC/USDT", "buy", 110, 1, 2000),
    rawExec("e3", "BTC/USDT", "sell", 120, 2, 3000),
  ];
  const { journal } = reconstructTrades(execs, [], ["BTC/USDT"], 4000);
  assert.equal(journal.length, 1);
  const t = journal[0]!;
  assert.equal(t.status, "closed");
  assert.equal(t.entryFills.length, 2);
  assert.equal(t.exitFills.length, 1);
  const avgEntry = t.entryFills.reduce((s, f) => s + f.qty * f.price, 0) / t.entryFills.reduce((s, f) => s + f.qty, 0);
  assert.equal(avgEntry, 105);
});

test("AC-56: buy 1@100 then sell 3@90 splits into a closed long and a flipped short", () => {
  const execs = [
    rawExec("e1", "BTC/USDT", "buy", 100, 1, 1000),
    rawExec("e2", "BTC/USDT", "sell", 90, 3, 2000, "Trade", 30), // fee 30, split 1/3 : 2/3
  ];
  const { journal } = reconstructTrades(execs, [], ["BTC/USDT"], 3000);
  assert.equal(journal.length, 2);
  const closed = journal.find((t) => t.status === "closed")!;
  const opened = journal.find((t) => t.status === "open")!;
  assert.equal(closed.side, "long");
  assert.equal(closed.exitFills.length, 1);
  assert.equal(closed.exitFills[0]!.execId, "e2");
  assert.equal(closed.exitFills[0]!.qty, 1);
  assert.ok(Math.abs(closed.exitFills[0]!.feeUsd - 10) < 1e-9);

  assert.equal(opened.side, "short");
  assert.equal(opened.entryFills[0]!.execId, "e2:flip");
  assert.equal(opened.entryFills[0]!.qty, 2);
  assert.ok(Math.abs(opened.entryFills[0]!.feeUsd - 20) < 1e-9);
});

test("AC-57: a sell whose closedSize closes an unseen long is skipped with a warning; the next opening fill is journaled", () => {
  const execs = [
    rawExec("e1", "APT/USDT", "sell", 10, 5, 1000, "Trade", 0, 5), // closes a long opened before journalStartTime
    rawExec("e3", "APT/USDT", "buy", 11, 1, 3000), // genuinely opens from flat (closedSize 0)
  ];
  const { journal, warnings } = reconstructTrades(execs, [], ["APT/USDT"], 4000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /APT\/USDT/);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.side, "long");
  assert.equal(journal[0]!.entryFills[0]!.execId, "e3");
});

test("AC-57: a BUY that closes an unseen short (closedSize = qty) is not mistaken for a new long", () => {
  const execs = [rawExec("e1", "SOL/USDT", "buy", 150, 3, 1000, "Trade", 0, 3)];
  const { journal, warnings } = reconstructTrades(execs, [], ["SOL/USDT"], 2000);
  assert.equal(journal.length, 0);
  assert.equal(warnings.length, 1);
});

test("AC-57: closedSize below qty journals only the remainder as a new position (execId:flip, fee pro rata)", () => {
  const execs = [rawExec("e1", "SOL/USDT", "buy", 150, 5, 1000, "Trade", 10, 2)];
  const { journal } = reconstructTrades(execs, [], ["SOL/USDT"], 2000);
  assert.equal(journal.length, 1);
  const t = journal[0]!;
  assert.equal(t.side, "long");
  assert.equal(t.entryFills[0]!.execId, "e1:flip");
  assert.equal(t.entryFills[0]!.qty, 3);
  assert.ok(Math.abs(t.entryFills[0]!.feeUsd - 6) < 1e-9);
});

test("AC-58: a re-sync with the same executions plus one new exit preserves plan links, notes and a thesis_invalidated override, without duplicating fills", () => {
  const existing: ManualTrade = {
    id: "existing-1", venue: "bybit-live", symbol: "BTC/USDT", side: "long",
    planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "h", plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [{ execId: "e1", time: 1000, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [], actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "watch the CPI print", createdAt: 1000, updatedAt: 1000,
  };
  const execs = [
    rawExec("e1", "BTC/USDT", "buy", 100, 1, 1000), // already known
    rawExec("e2", "BTC/USDT", "sell", 90, 1, 2000), // new: closes it
  ];
  const { journal } = reconstructTrades(execs, [existing], ["BTC/USDT"], 3000);
  assert.equal(journal.length, 1);
  const t = journal[0]!;
  assert.equal(t.id, "existing-1");
  assert.equal(t.planId, "2026-09-16:r1:BTC/USDT");
  assert.equal(t.notes, "watch the CPI print");
  assert.equal(t.entryFills.length, 1); // e1 not duplicated
  assert.equal(t.exitFills.length, 1);
  assert.equal(t.status, "closed");

  // Now simulate the owner overriding exitKind to thesis_invalidated, then a further re-sync
  // with no new executions preserves it verbatim.
  const overridden: ManualTrade = { ...t, exitKind: "thesis_invalidated" };
  const { journal: resynced } = reconstructTrades(execs, [overridden], ["BTC/USDT"], 4000);
  assert.equal(resynced.length, 1);
  assert.equal(resynced[0]!.exitKind, "thesis_invalidated");
});

test("AC-61: exit classification — BustTrade, stop, target, time, discretionary", () => {
  const plan = (overrides: Partial<Extract<TradePlan, { kind: "plan" }>> = {}): Extract<TradePlan, { kind: "plan" }> => ({
    kind: "plan", planId: "p", ruleId: "r1", ruleHash: "h", origin: "rules-file", symbol: "BTC/USDT", side: "long",
    referencePrice: 100, stopPrice: 90, targetPrice: 120, expiresAt: 0,
    quantity: 1, notionalUsd: 100, riskUsd: 10, leverage: 1, marginUsd: 100,
    estLiquidationPrice: 50, liqToStopRatio: 2, estRoundTripFeeUsd: 0, venueIntent: "live", maxHoldDays: 5,
    ...overrides,
  });
  const existingWithPlan = (p: Extract<TradePlan, { kind: "plan" }>, entryTime: number): ManualTrade => ({
    id: "x", venue: "bybit-live", symbol: "BTC/USDT", side: "long",
    planId: p.planId, ruleId: p.ruleId, ruleHash: p.ruleHash, plannedSnapshot: p, aiStanceAtPlan: null,
    entryFills: [{ execId: "e0", time: entryTime, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [], actualLeverage: 1, exchangeLiqPrice: 50, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: entryTime, updatedAt: entryTime,
  });

  const dayMs = 24 * 60 * 60 * 1000;

  // BustTrade -> liquidation regardless of price
  {
    const prior = existingWithPlan(plan(), 0);
    const { journal } = reconstructTrades([rawExec("x1", "BTC/USDT", "sell", 100, 1, 1000, "BustTrade")], [prior], ["BTC/USDT"], 2000);
    assert.equal(journal[0]!.exitKind, "liquidation");
  }
  // avgExit 92 -> stop (d=10, stop+0.25d=92.5)
  {
    const prior = existingWithPlan(plan(), 0);
    const { journal } = reconstructTrades([rawExec("x1", "BTC/USDT", "sell", 92, 1, 1000)], [prior], ["BTC/USDT"], 2000);
    assert.equal(journal[0]!.exitKind, "stop");
  }
  // avgExit 118 -> target (target-0.25d=117.5)
  {
    const prior = existingWithPlan(plan(), 0);
    const { journal } = reconstructTrades([rawExec("x1", "BTC/USDT", "sell", 118, 1, 1000)], [prior], ["BTC/USDT"], 2000);
    assert.equal(journal[0]!.exitKind, "target");
  }
  // avgExit 116 before the hold limit -> discretionary
  {
    const prior = existingWithPlan(plan(), 0);
    const { journal } = reconstructTrades([rawExec("x1", "BTC/USDT", "sell", 116, 1, 1000)], [prior], ["BTC/USDT"], 2000);
    assert.equal(journal[0]!.exitKind, "discretionary");
  }
  // avgExit 105 after 4d23h -> time (maxHoldDays 5: threshold is entered + 119h)
  {
    const entryTime = 0;
    const exitTime = entryTime + 4 * dayMs + 23 * 60 * 60 * 1000;
    const prior = existingWithPlan(plan(), entryTime);
    const { journal } = reconstructTrades([rawExec("x1", "BTC/USDT", "sell", 105, 1, exitTime)], [prior], ["BTC/USDT"], exitTime + 1000);
    assert.equal(journal[0]!.exitKind, "time");
  }
  // avgExit 105 after 1 day -> discretionary
  {
    const entryTime = 0;
    const exitTime = entryTime + dayMs;
    const prior = existingWithPlan(plan(), entryTime);
    const { journal } = reconstructTrades([rawExec("x1", "BTC/USDT", "sell", 105, 1, exitTime)], [prior], ["BTC/USDT"], exitTime + 1000);
    assert.equal(journal[0]!.exitKind, "discretionary");
  }
  // unplanned -> unknown
  {
    const { journal } = reconstructTrades(
      [rawExec("e1", "BTC/USDT", "buy", 100, 1, 0), rawExec("e2", "BTC/USDT", "sell", 100, 1, 1000)],
      [], ["BTC/USDT"], 2000,
    );
    assert.equal(journal[0]!.exitKind, "unknown");
  }
});

// ── syncFromExchange (AC-28, AC-59, AC-60, AC-63b) ───────────────────────────────────────────────

test("AC-59: journalStartTime null makes zero REST calls and returns status failed", async () => {
  let calls = 0;
  const rest = fakeRest({
    getExecutions: async () => { calls++; return { list: [], nextPageCursor: "" }; },
    getFundingExecutions: async () => { calls++; return { list: [], nextPageCursor: "" }; },
    getPositions: async () => { calls++; return { list: [] }; },
  });
  const { journal, result } = await syncFromExchange([], rest, { symbols: ["BTC/USDT"], journalStartTime: null }, 1000);
  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "manual.journalStartTime not set");
  assert.deepEqual(journal, []);
});

test("AC-28: the same execution returned by two syncs is journaled once", async () => {
  const bybitExec = { execId: "abc", symbol: "BTCUSDT", side: "Buy", execPrice: "100", execQty: "1", execFee: "0.05", execTime: "1000", execType: "Trade", closedSize: "0" };
  const rest = fakeRest({
    getExecutions: async () => ({ list: [bybitExec], nextPageCursor: "" }),
  });
  const first = await syncFromExchange([], rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 2000);
  assert.equal(first.result.status, "ok");
  assert.equal(first.result.newFills, 1);

  const second = await syncFromExchange(first.journal, rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 3000);
  assert.equal(second.result.newFills, 0);
  const totalFills = second.journal.reduce((sum, t) => sum + t.entryFills.length + t.exitFills.length, 0);
  assert.equal(totalFills, 1);
});

test("Funding executions in the execution list are ignored, never replayed as trades", async () => {
  const funding = { execId: "f1", symbol: "BTCUSDT", side: "Sell", execPrice: "100", execQty: "1", execFee: "0.01", execTime: "900", execType: "Funding", closedSize: "0" };
  const trade = { execId: "t1", symbol: "BTCUSDT", side: "Buy", execPrice: "100", execQty: "1", execFee: "0.05", execTime: "1000", execType: "Trade", closedSize: "0" };
  const rest = fakeRest({ getExecutions: async () => ({ list: [funding, trade], nextPageCursor: "" }) });
  const { journal, result } = await syncFromExchange([], rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 2000);
  assert.equal(result.status, "ok");
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0]!.entryFills.map((f) => f.execId), ["t1"]);
});

test("An unsupported execType or an unparseable execution fails the sync and leaves the journal unchanged", async () => {
  for (const bad of [
    { execId: "s1", symbol: "BTCUSDT", side: "Buy", execPrice: "100", execQty: "1", execFee: "0", execTime: "1000", execType: "Settle", closedSize: "0" },
    { execId: "t2", symbol: "BTCUSDT", side: "Buy", execPrice: "100", execQty: "1", execFee: "0", execTime: "1000", execType: "Trade" }, // no closedSize
  ]) {
    const rest = fakeRest({ getExecutions: async () => ({ list: [bad], nextPageCursor: "" }) });
    const { journal, result } = await syncFromExchange([], rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 2000);
    assert.equal(result.status, "failed");
    assert.deepEqual(journal, []);
  }
});

test("funding for a 20-day trade is summed across 7-day windows and cursor pages, never truncated", async () => {
  const DAY = 86_400_000;
  const entry = { execId: "t1", symbol: "BTCUSDT", side: "Buy", execPrice: "100", execQty: "1", execFee: "0", execTime: String(DAY), execType: "Trade", closedSize: "0" };
  const exit = { execId: "t2", symbol: "BTCUSDT", side: "Sell", execPrice: "100", execQty: "1", execFee: "0", execTime: String(21 * DAY), execType: "Trade", closedSize: "1" };
  // One funding row per day (execFee 0.01 = paid), served only for the requested window, 5 rows per page.
  const fundingRows = Array.from({ length: 20 }, (_, i) => ({ execId: `f${i}`, execTime: String(DAY + (i + 0.5) * DAY), execFee: "0.01" }));
  const windows: [number, number][] = [];
  const rest = fakeRest({
    getExecutions: async () => ({ list: [entry, exit], nextPageCursor: "" }),
    getFundingExecutions: async (_c, _s, startTime, endTime, cursor) => {
      if (cursor === undefined) windows.push([startTime, endTime]);
      const inWindow = fundingRows.filter((r) => Number(r.execTime) >= startTime && Number(r.execTime) <= endTime);
      const offset = cursor === undefined ? 0 : Number(cursor);
      const page = inWindow.slice(offset, offset + 5);
      return { list: page, nextPageCursor: offset + 5 < inWindow.length ? String(offset + 5) : "" };
    },
  });
  const { journal, result } = await syncFromExchange([], rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 22 * DAY);
  assert.equal(result.status, "ok");
  assert.ok(windows.length >= 3, `expected ≥3 windows for a 20-day hold, got ${windows.length}`);
  assert.ok(windows.every(([s, e]) => e - s <= 7 * DAY));
  assert.ok(Math.abs(journal[0]!.fundingUsd - -0.2) < 1e-9, `fundingUsd ${journal[0]!.fundingUsd}`);
});

test("an unparseable funding row fails the sync instead of being skipped", async () => {
  const entry = { execId: "t1", symbol: "BTCUSDT", side: "Buy", execPrice: "100", execQty: "1", execFee: "0", execTime: "1000", execType: "Trade", closedSize: "0" };
  const rest = fakeRest({
    getExecutions: async () => ({ list: [entry], nextPageCursor: "" }),
    getFundingExecutions: async () => ({ list: [{ execId: "f1", execTime: "1500", execFee: "n/a" }], nextPageCursor: "" }),
  });
  const { journal, result } = await syncFromExchange([], rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 2000);
  assert.equal(result.status, "failed");
  assert.deepEqual(journal, []);
});

test("positions are requested with settleCoin USDT (Bybit rejects an unfiltered linear position list with 10001)", async () => {
  const calls: unknown[][] = [];
  const rest = fakeRest({
    getPositions: (async (...args: unknown[]) => {
      calls.push(args);
      // Mirror the real API: without symbol or settleCoin the request is rejected.
      if (args[1] === undefined && args[2] === undefined) throw new Error("Bybit API error [10001]: symbol or settleCoin required");
      return { list: [] };
    }) as FakeRest["getPositions"],
  });
  const { result } = await syncFromExchange([], rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 2000);
  assert.equal(result.status, "ok", result.error ?? "");
  assert.deepEqual(calls, [["linear", undefined, "USDT"]]);
});

test("AC-60: a funding history rejection leaves the journal unchanged and status failed", async () => {
  const bybitExec = { execId: "abc", symbol: "BTCUSDT", side: "Buy", execPrice: "100", execQty: "1", execFee: "0.05", execTime: "1000", execType: "Trade", closedSize: "0" };
  const rest = fakeRest({
    getExecutions: async () => ({ list: [bybitExec], nextPageCursor: "" }),
    getFundingExecutions: async () => { throw new Error("funding endpoint down"); },
  });
  const before: ManualTrade[] = [];
  const { journal, result } = await syncFromExchange(before, rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 2000);
  assert.equal(result.status, "failed");
  assert.deepEqual(journal, before);
});

test("AC-63b: an open trade for a symbol removed from config.symbols is still fetched and closed, with a warning", async () => {
  const openApt: ManualTrade = {
    id: "apt-1", venue: "bybit-live", symbol: "APT/USDT", side: "long",
    planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [{ execId: "e1", time: 1000, price: 10, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [], actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: 1000, updatedAt: 1000,
  };
  const fetchedSymbols: string[] = [];
  const bybitExit = { execId: "e2", symbol: "APTUSDT", side: "Sell", execPrice: "11", execQty: "1", execFee: "0", execTime: "5000", execType: "Trade", closedSize: "1" };
  const rest = fakeRest({
    getExecutions: async (_c, symbol) => {
      fetchedSymbols.push(symbol);
      return symbol === "APTUSDT" ? { list: [bybitExit], nextPageCursor: "" } : { list: [], nextPageCursor: "" };
    },
  });
  const { journal, result } = await syncFromExchange([openApt], rest, { symbols: ["BTC/USDT"], journalStartTime: 0 }, 6000);
  assert.equal(result.status, "ok");
  assert.ok(fetchedSymbols.includes("APTUSDT"));
  assert.ok(result.warnings.some((w) => w.includes("APT/USDT")));
  const apt = journal.find((t) => t.symbol === "APT/USDT")!;
  assert.equal(apt.status, "closed");
});
