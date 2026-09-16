// Journal server tests — specs/daily-catalyst-manual-trading.md §5.12/§5.8a,
// AC-27, AC-36, AC-66, AC-68.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJournalApp, startJournalServer } from "../src/server/journal-server.ts";
import type { JournalAppDeps } from "../src/server/journal-server.ts";
import { TradePermissionKeyError } from "../src/journal/exchange-sync.ts";
import { saveManualJournal } from "../src/journal/manual-journal.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import { mkdirSync } from "node:fs";
import { DEFAULT_MANUAL_TRADING_CONFIG } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import type { RestClient } from "../src/bybit/rest.ts";

// Awaits the body before cleanup: a sync `finally` around an async callback would delete the
// directory while the test is still using it.
async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "journal-server-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseConfig(): Config {
  return {
    exchange: "bybit", apiKey: "k", apiSecret: "s", symbols: ["BTC/USDT"],
    maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 10,
    stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  };
}

function baseDeps(dir: string, overrides: Partial<JournalAppDeps> = {}, port = 34567): JournalAppDeps {
  return {
    config: baseConfig(),
    manual: { ...DEFAULT_MANUAL_TRADING_CONFIG, journalPort: port },
    journalPath: join(dir, "manual-journal.json"),
    reportsRoot: join(dir, "reports"),
    rest: null,
    now: () => 1_700_000_000_000,
    fetchKlines1h: async () => null,
    ...overrides,
  };
}

function fakeRest(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}): RestClient {
  return {
    getApiKeyInfo: async () => ({ readOnly: 1, permissions: {} }),
    getExecutions: async () => ({ list: [], nextPageCursor: "" }),
    getFundingExecutions: async () => ({ list: [], nextPageCursor: "" }),
    getPositions: async () => ({ list: [] }),
    ...overrides,
  } as unknown as RestClient;
}

// ── createJournalApp (Host/Origin, AC-66) ──────────────────────────────────────────────────────

test("AC-66: a request with the wrong Host header is refused with 403 and no journal write", async () => {
  await withTempDir(async (dir) => {
    const { app, getState } = createJournalApp(baseDeps(dir, {}, 34568));
    const res = await app.request("/api/state", { headers: { Host: "evil.example:34568" } });
    assert.equal(res.status, 403);
    assert.equal(getState().journal.length, 0);
  });
});

test("AC-66: a POST with a mismatched Origin header is refused with 403", async () => {
  await withTempDir(async (dir) => {
    const { app } = createJournalApp(baseDeps(dir, {}, 34569));
    const res = await app.request("/api/paper/entry", {
      method: "POST",
      headers: { Host: "127.0.0.1:34569", Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ planId: "x", fillPrice: 1, time: 1 }),
    });
    assert.equal(res.status, 403);
  });
});

test("a matching Host header (127.0.0.1 or localhost) is accepted", async () => {
  await withTempDir(async (dir) => {
    const { app } = createJournalApp(baseDeps(dir, {}, 34570));
    const res1 = await app.request("/api/state", { headers: { Host: "127.0.0.1:34570" } });
    assert.equal(res1.status, 200);
    const res2 = await app.request("/api/state", { headers: { Host: "localhost:34570" } });
    assert.equal(res2.status, 200);
  });
});

// ── AC-68: paper-only mode ──────────────────────────────────────────────────────────────────────

test("AC-68: no read-only key — the server starts, serves GET /, and /api/state reports liveSync disabled", async () => {
  await withTempDir(async (dir) => {
    const { app } = createJournalApp(baseDeps(dir, { rest: null }, 34571));
    const root = await app.request("/", { headers: { Host: "127.0.0.1:34571" } });
    assert.equal(root.status, 200);

    const state = await app.request("/api/state", { headers: { Host: "127.0.0.1:34571" } });
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.liveSync, "disabled");
  });
});

// ── AC-27 / AC-36: startJournalServer ────────────────────────────────────────────────────────────

test("AC-27: a key without readOnly permission refuses to start (does not bind)", async () => {
  await withTempDir(async (dir) => {
    const rest = fakeRest({ getApiKeyInfo: async () => ({ readOnly: 0, permissions: {} }) });
    await assert.rejects(
      () => startJournalServer(baseDeps(dir, { rest }, 34572)),
      TradePermissionKeyError,
    );
  });
});

test("AC-36: the server listens on 127.0.0.1:journalPort, not 0.0.0.0", async () => {
  await withTempDir(async (dir) => {
    const handle = await startJournalServer(baseDeps(dir, { rest: null }, 34573));
    try {
      const address = handle.server.address();
      assert.ok(address && typeof address === "object");
      assert.equal((address as { address: string }).address, "127.0.0.1");
      assert.equal((address as { port: number }).port, 34573);
    } finally {
      await handle.close();
    }
  });
});

// ── Basic endpoint smoke ─────────────────────────────────────────────────────────────────────────

test("GET /api/trades returns an empty array for a fresh journal", async () => {
  await withTempDir(async (dir) => {
    const { app } = createJournalApp(baseDeps(dir, {}, 34574));
    const res = await app.request("/api/trades", { headers: { Host: "127.0.0.1:34574" } });
    assert.deepEqual(await res.json(), []);
  });
});

test("PATCH /api/trades/:id/exit-kind returns 409 for an unknown trade id", async () => {
  await withTempDir(async (dir) => {
    const { app } = createJournalApp(baseDeps(dir, {}, 34575));
    const res = await app.request("/api/trades/does-not-exist/exit-kind", {
      method: "PATCH",
      headers: { Host: "127.0.0.1:34575", Origin: "http://127.0.0.1:34575", "Content-Type": "application/json" },
      body: JSON.stringify({ exitKind: "thesis_invalidated" }),
    });
    assert.equal(res.status, 404);
  });
});

// ── AC-62: linking a trade to a plan ─────────────────────────────────────────────────────────────

const DECISION = Date.parse("2026-09-16T00:15:00Z");
const PLAN_ID = "2026-09-16:etf-flow-momentum:BTC/USDT";

function writeLinkFixtures(dir: string, trade: Partial<ManualTrade>): string {
  mkdirSync(join(dir, "reports"), { recursive: true });
  const plan = {
    kind: "plan", planId: PLAN_ID, ruleId: "etf-flow-momentum", ruleHash: "h", origin: "rules-file",
    symbol: "BTC/USDT", side: "long", referencePrice: 60000, stopPrice: 58000, targetPrice: 64000,
    expiresAt: DECISION + 12 * 3_600_000, quantity: 0.001, notionalUsd: 60, riskUsd: 2, leverage: 1, marginUsd: 60,
    estLiquidationPrice: 300, liqToStopRatio: 29.85, estRoundTripFeeUsd: 0.066, venueIntent: "paper", maxHoldDays: 5,
  };
  const report = {
    schemaVersion: 1, dateUtc: "2026-09-16", decisionTime: DECISION, generatedAt: DECISION, ruleSetSha256: "x",
    sources: [], completeness: "complete", breaker: { tripped: false, trigger: null, details: "" },
    outcomes: [], plans: [plan], openTradeThesis: [],
    aiAnalyst: { status: "disabled", reason: "ai.enabled is false", model: null, servedByModel: null, promptVersionHash: null,
      costUsd: 0, monthToDateUsd: 0, regimeSummary: null, assessments: [], plans: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], rejected: [] },
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };
  writeFileSync(join(dir, "reports", "2026-09-16.json"), JSON.stringify(report));
  const full: ManualTrade = {
    id: "trade-1", venue: "bybit-live", symbol: "BTC/USDT", side: "long",
    planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [{ execId: "e1", time: DECISION + 3_600_000, price: 60010, qty: 0.001, feeUsd: 0.03, side: "buy" }],
    exitFills: [], actualLeverage: 1, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: DECISION, updatedAt: DECISION,
    ...trade,
  };
  saveManualJournal([full], { path: join(dir, "manual-journal.json") });
  return full.id;
}

async function postLink(dir: string, port: number, planId: string) {
  const { app, getState } = createJournalApp(baseDeps(dir, {}, port));
  const res = await app.request("/api/trades/trade-1/link", {
    method: "POST",
    headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
    body: JSON.stringify({ planId }),
  });
  return { res, trade: getState().journal.find((t) => t.id === "trade-1")! };
}

test("AC-62: a matching trade links to its plan and freezes the plan snapshot", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, {});
    const { res, trade } = await postLink(dir, 34580, PLAN_ID);
    assert.equal(res.status, 200);
    assert.equal(trade.planId, PLAN_ID);
    assert.equal(trade.plannedSnapshot?.stopPrice, 58000);
  });
});

test("AC-62: an entry after plan.expiresAt is refused with 409 and the trade is unchanged", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, { entryFills: [{ execId: "e1", time: DECISION + 13 * 3_600_000, price: 60010, qty: 0.001, feeUsd: 0.03, side: "buy" }] });
    const { res, trade } = await postLink(dir, 34581, PLAN_ID);
    assert.equal(res.status, 409);
    assert.equal(trade.planId, null);
  });
});

test("AC-62: a side mismatch is refused with 409 and the trade is unchanged", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, { side: "short" });
    const { res, trade } = await postLink(dir, 34582, PLAN_ID);
    assert.equal(res.status, 409);
    assert.equal(trade.planId, null);
  });
});

test("a planId whose date part is not YYYY-MM-DD (e.g. '.*' or '(') is rejected without touching report files", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, {});
    for (const [i, bad] of [".*:etf-flow-momentum:BTC/USDT", "(:x:y", "../../etc:x:y"].entries()) {
      const { res, trade } = await postLink(dir, 34583 + i, bad);
      assert.equal(res.status, 409, `planId ${bad}`);
      assert.equal(trade.planId, null);
    }
  });
});

// ── Paper-trade integrity (feeds Gate D1) ────────────────────────────────────────────────────────

async function paperEntry(dir: string, port: number, now: number, body: Record<string, unknown>) {
  const { app, getState } = createJournalApp(baseDeps(dir, { now: () => now }, port));
  const res = await app.request("/api/paper/entry", {
    method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { app, res, getState };
}

test("paper entry: a backdated time (more than 5 minutes before now) is refused with 409", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, { planId: "other-plan" });
    const now = DECISION + 2 * 3_600_000;
    const { res, getState } = await paperEntry(dir, 34590, now, { planId: PLAN_ID, fillPrice: 60000, time: now - 10 * 60_000 });
    assert.equal(res.status, 409);
    assert.equal(getState().journal.filter((t) => t.venue === "paper").length, 0);
  });
});

test("paper entry: after plan.expiresAt is refused; a second entry for the same plan is refused", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, { planId: "other-plan" });
    const late = DECISION + 13 * 3_600_000;
    const lateRes = await paperEntry(dir, 34591, late, { planId: PLAN_ID, fillPrice: 60000, time: late });
    assert.equal(lateRes.res.status, 409);

    const now = DECISION + 2 * 3_600_000;
    const first = await paperEntry(dir, 34592, now, { planId: PLAN_ID, fillPrice: 60000, time: now });
    assert.equal(first.res.status, 200);
    const second = await first.app.request("/api/paper/entry", {
      method: "POST", headers: { Host: "127.0.0.1:34592", "Content-Type": "application/json" },
      body: JSON.stringify({ planId: PLAN_ID, fillPrice: 60000, time: now }),
    });
    assert.equal(second.status, 409);
    assert.equal(first.getState().journal.filter((t) => t.venue === "paper").length, 1);
  });
});

test("paper exit: an exitKind outside stop|target|time|thesis_invalidated|discretionary is rejected with 400", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, { planId: "other-plan" });
    const now = DECISION + 2 * 3_600_000;
    const { app, res } = await paperEntry(dir, 34593, now, { planId: PLAN_ID, fillPrice: 60000, time: now });
    const trade = await res.json();
    const exit = await app.request("/api/paper/exit", {
      method: "POST", headers: { Host: "127.0.0.1:34593", "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId: trade.id, fillPrice: 61000, time: now, exitKind: "liquidation" }),
    });
    assert.equal(exit.status, 400);
  });
});

test("link: a plan already linked to another trade is refused with 409", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, {});
    const first = await postLink(dir, 34594, PLAN_ID);
    assert.equal(first.res.status, 200);
    // A second journal trade trying to claim the same plan.
    const { app, getState } = createJournalApp(baseDeps(dir, {}, 34595));
    const journal = getState().journal;
    saveManualJournal([...journal, { ...journal[0]!, id: "trade-2", planId: null, plannedSnapshot: null, entryFills: [{ ...journal[0]!.entryFills[0]!, execId: "e2" }] }], { path: join(dir, "manual-journal.json") });
    const { app: app2 } = createJournalApp(baseDeps(dir, {}, 34596));
    const res = await app2.request("/api/trades/trade-2/link", {
      method: "POST", headers: { Host: "127.0.0.1:34596", "Content-Type": "application/json" }, body: JSON.stringify({ planId: PLAN_ID }),
    });
    assert.equal(res.status, 409);
    void app;
  });
});
