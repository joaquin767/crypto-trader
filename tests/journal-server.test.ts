// Journal server tests — specs/daily-catalyst-manual-trading.md §5.12/§5.8a/§5.14,
// AC-27, AC-36, AC-66, AC-68, AC-71, AC-73.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJournalApp, startJournalServer } from "../src/server/journal-server.ts";
import type { JournalAppDeps } from "../src/server/journal-server.ts";
import { TradePermissionKeyError } from "../src/journal/exchange-sync.ts";
import { saveManualJournal } from "../src/journal/manual-journal.ts";
import type { JournalSyncStatus } from "../src/journal/manual-journal.ts";
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
    decisionsRoot: join(dir, "decisions"),
    syncStatusPath: join(dir, "manual-journal.sync.json"),
    rest: null,
    now: () => 1_700_000_000_000,
    fetchKlines: async () => null,
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

// ── §5.15 revision 3: sync-freshness sidecar ─────────────────────────────────────────────────────

test("syncOnce writes manual-journal.sync.json after every attempt, including the paper-only branch", async () => {
  await withTempDir(async (dir) => {
    const syncStatusPath = join(dir, "manual-journal.sync.json");
    const { syncOnce } = createJournalApp(baseDeps(dir, { rest: null, syncStatusPath }, 34574));
    assert.equal(existsSync(syncStatusPath), false);
    await syncOnce();
    assert.equal(existsSync(syncStatusPath), true);
    const status = JSON.parse(readFileSync(syncStatusPath, "utf-8")) as JournalSyncStatus;
    assert.equal(status.liveSync, "disabled");
    assert.equal(status.status, "failed"); // no read-only key configured
  });
});

test("syncOnce writes liveSync 'enabled' with the real sync result when a rest client is configured", async () => {
  await withTempDir(async (dir) => {
    const syncStatusPath = join(dir, "manual-journal.sync.json");
    const rest = fakeRest({ getExecutions: async () => ({ list: [], nextPageCursor: "" }) });
    const { syncOnce } = createJournalApp(baseDeps(dir, { rest, syncStatusPath, config: { ...baseConfig(), symbols: ["BTC/USDT"] } }, 34575));
    await syncOnce();
    const status = JSON.parse(readFileSync(syncStatusPath, "utf-8")) as JournalSyncStatus;
    assert.equal(status.liveSync, "enabled");
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

// ── AC-117: persona planId resolution from data/decisions/ (revision 3) ─────────────────────────

const PERSONA_PLAN_ID = "2026-09-16:persona-3f9a1c2b:BTC/USDT";

function writePersonaDecision(dir: string, overrides: { executeUntil?: number } = {}): void {
  mkdirSync(join(dir, "decisions"), { recursive: true });
  const plan = {
    kind: "plan", planId: PERSONA_PLAN_ID, ruleId: "persona-3f9a1c2b", ruleHash: "h".repeat(64), origin: "persona",
    symbol: "BTC/USDT", side: "long", referencePrice: 60000, stopPrice: 58000, targetPrice: 64000,
    expiresAt: DECISION + 12 * 3_600_000, quantity: 0.0005, notionalUsd: 30, riskUsd: 1, leverage: 1, marginUsd: 30,
    estLiquidationPrice: 300, liqToStopRatio: 29.85, estRoundTripFeeUsd: 0.033, venueIntent: "paper", maxHoldDays: 5,
  };
  const decision = {
    schemaVersion: 1, dateUtc: "2026-09-16", revision: 0, decidedAt: DECISION + 1_800_000,
    skillHash: "h".repeat(64), reportPath: "reports/2026-09-16.json", reportSha256: "x", reportDecisionTime: DECISION,
    input: { dateUtc: "2026-09-16", choice: { kind: "no-trade", reason: "unused" }, stances: [], news: [], rationale: "r" },
    validation: { ok: true, rejections: [], unverifiedWebRefs: [] },
    plan, personaRule: null, basedOnPlanId: null, basedOnRuleKey: null,
    ownerProtocol: {
      decidedAt: DECISION + 1_800_000, executeFrom: DECISION + 1_800_000,
      executeUntil: overrides.executeUntil ?? DECISION + 1_800_000 + 21_600_000,
      referencePrice: 60000, atr14d: 1000, maxEntryGapAbs: 250, entryBand: [59750, 60250],
      venueIntent: "paper", leverage: 1, marginMode: "isolated", orders: [], recordVia: "paper-api",
      timeExitOnOrBefore: DECISION + 5 * 86_400_000, nextReportAt: DECISION + 86_400_000,
      ownerTimeZone: "America/Argentina/Buenos_Aires",
    },
    ownerTimeZone: "America/Argentina/Buenos_Aires",
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };
  writeFileSync(join(dir, "decisions", "2026-09-16.json"), JSON.stringify(decision));
}

test("AC-117: a persona-* planId links from data/decisions/, inside the decision's own execute window", async () => {
  await withTempDir(async (dir) => {
    writePersonaDecision(dir);
    writeLinkFixtures(dir, { entryFills: [{ execId: "e1", time: DECISION + 1_800_000 + 1000, price: 60000, qty: 0.0005, feeUsd: 0, side: "buy" }] });
    const { res, trade } = await postLink(dir, 34595, PERSONA_PLAN_ID);
    assert.equal(res.status, 200);
    assert.equal(trade.planId, PERSONA_PLAN_ID);
    assert.equal(trade.aiStanceAtPlan, null);
  });
});

test("AC-117: entering after the decision's executeUntil is refused with 409", async () => {
  await withTempDir(async (dir) => {
    writePersonaDecision(dir);
    writeLinkFixtures(dir, { entryFills: [{ execId: "e1", time: DECISION + 1_800_000 + 21_600_000 + 1000, price: 60000, qty: 0.0005, feeUsd: 0, side: "buy" }] });
    const { res, trade } = await postLink(dir, 34596, PERSONA_PLAN_ID);
    assert.equal(res.status, 409);
    assert.equal(trade.planId, null);
  });
});

test("AC-117: a persona-* planId with no decision file on disk is 404, never looked up in reports/", async () => {
  await withTempDir(async (dir) => {
    writeLinkFixtures(dir, {}); // writes reports/2026-09-16.json but no data/decisions/
    const { res } = await postLink(dir, 34597, PERSONA_PLAN_ID);
    assert.equal(res.status, 404);
  });
});

test("AC-117: POST /api/paper/entry with a persona-* planId records a paper trade against it", async () => {
  await withTempDir(async (dir) => {
    writePersonaDecision(dir);
    const now = DECISION + 1_800_000 + 1000;
    const { res, getState } = await paperEntry(dir, 34598, now, { planId: PERSONA_PLAN_ID, fillPrice: 60000, time: now });
    assert.equal(res.status, 200);
    assert.equal(getState().journal.filter((t) => t.venue === "paper" && t.planId === PERSONA_PLAN_ID).length, 1);
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

// ── AC-73 / AC-71: trade chart endpoint ─────────────────────────────────────────────────────────

function openPaperTrade(overrides: Partial<ManualTrade> = {}): ManualTrade {
  return {
    id: "trade-open", venue: "paper", symbol: "BTC/USDT", side: "long",
    planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [{ execId: "e1", time: 1_700_000_000_000, price: 100, qty: 2, feeUsd: 0.2, side: "buy" }],
    exitFills: [], actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("AC-73: GET /api/trades/:id/chart returns 404 for an unknown trade id", async () => {
  await withTempDir(async (dir) => {
    const { app } = createJournalApp(baseDeps(dir, {}, 34600));
    const res = await app.request("/api/trades/does-not-exist/chart", { headers: { Host: "127.0.0.1:34600" } });
    assert.equal(res.status, 404);
  });
});

test("AC-73: a failed kline fetch yields 200 with dataStatus unavailable, empty candles and no band", async () => {
  await withTempDir(async (dir) => {
    const trade = openPaperTrade();
    saveManualJournal([trade], { path: join(dir, "manual-journal.json") });
    const { app } = createJournalApp(baseDeps(dir, {
      fetchKlines: async () => null,
      now: () => trade.entryFills[0]!.time + 60_000,
    }, 34601));
    const res = await app.request(`/api/trades/${trade.id}/chart`, { headers: { Host: "127.0.0.1:34601" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dataStatus, "unavailable");
    assert.deepEqual(body.candles, []);
    assert.equal(body.band, null);
  });
});

test("AC-73: an open paper long's chart reports unrealized P&L from the last closed candle", async () => {
  await withTempDir(async (dir) => {
    const entryTime = 1_700_000_000_000;
    const trade = openPaperTrade({
      entryFills: [{ execId: "e1", time: entryTime, price: 100, qty: 2, feeUsd: 0.2, side: "buy" }],
    });
    saveManualJournal([trade], { path: join(dir, "manual-journal.json") });
    const now = entryTime + 35 * 60_000; // past the 2nd bar's close (entry+30min) -> not a forming candle
    const fetchKlines: JournalAppDeps["fetchKlines"] = async (_symbol, interval) => {
      if (interval === "D") return [];
      return [
        { t: entryTime, o: 100, h: 100, l: 100, c: 100, v: 1 },
        { t: entryTime + 15 * 60_000, o: 100, h: 105, l: 100, c: 105, v: 1 },
      ];
    };
    const { app } = createJournalApp(baseDeps(dir, { fetchKlines, now: () => now }, 34602));
    const res = await app.request(`/api/trades/${trade.id}/chart`, { headers: { Host: "127.0.0.1:34602" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.interval, "15");
    assert.deepEqual(body.pnl, { kind: "unrealized", usd: 9.8, basis: "last 15m close" });
  });
});

test("AC-71: reviewClosedTrade (via GET /api/review/:id) receives all bars for a 240h trade", async () => {
  await withTempDir(async (dir) => {
    const entryTime = 1_700_000_000_000;
    const exitTime = entryTime + 240 * 3_600_000;
    const trade: ManualTrade = {
      id: "closed-1", venue: "paper", symbol: "BTC/USDT", side: "long",
      planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null, aiStanceAtPlan: null,
      entryFills: [{ execId: "e1", time: entryTime, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
      exitFills: [{ execId: "x1", time: exitTime, price: 110, qty: 1, feeUsd: 0, side: "sell" }],
      actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
      status: "closed", exitKind: "target", notes: "", createdAt: entryTime, updatedAt: exitTime,
    };
    saveManualJournal([trade], { path: join(dir, "manual-journal.json") });
    let receivedBarCount = 0;
    const fetchKlines: JournalAppDeps["fetchKlines"] = async (_symbol, interval, start, end) => {
      assert.equal(interval, "60");
      const bars = [];
      for (let t = start; t <= end; t += 3_600_000) bars.push({ t, o: 100, h: 100, l: 100, c: 100, v: 1 });
      receivedBarCount = bars.length;
      return bars;
    };
    const { app } = createJournalApp(baseDeps(dir, { fetchKlines, now: () => exitTime + 60_000 }, 34603));
    const res = await app.request(`/api/review/${trade.id}`, { headers: { Host: "127.0.0.1:34603" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.maeMfeAvailable, true);
    assert.ok(receivedBarCount >= 240, `expected >= 240 bars, got ${receivedBarCount}`);
  });
});

test("a closed trade's chart is not cached after a failed kline fetch: the next request retries and succeeds", async () => {
  await withTempDir(async (dir) => {
    const entryT = 1_700_000_000_000;
    const exitT = entryT + 3 * 3_600_000;
    const trade = openPaperTrade({
      id: "trade-closed", status: "closed", exitKind: "discretionary", updatedAt: exitT,
      exitFills: [{ execId: "x1", time: exitT, price: 110, qty: 2, feeUsd: 0.22, side: "sell" }],
    });
    saveManualJournal([trade], { path: join(dir, "manual-journal.json") });
    let fail = true;
    let calls = 0;
    const bars = Array.from({ length: 40 }, (_, i) => {
      const t = entryT - 6 * 900_000 + i * 900_000;
      return { t, o: 100, h: 101, l: 99, c: 100 + i * 0.1, v: 1 };
    });
    const { app } = createJournalApp(baseDeps(dir, {
      fetchKlines: async () => { calls++; return fail ? null : bars; },
      now: () => exitT + 3_600_000,
    }, 34610));
    const first = await (await app.request(`/api/trades/${trade.id}/chart`, { headers: { Host: "127.0.0.1:34610" } })).json();
    assert.equal(first.dataStatus, "unavailable");
    fail = false;
    const callsBefore = calls;
    const second = await (await app.request(`/api/trades/${trade.id}/chart`, { headers: { Host: "127.0.0.1:34610" } })).json();
    assert.equal(second.dataStatus, "ok");
    assert.ok(calls > callsBefore, "second request must fetch again, not serve a cached failure");
    // A successful closed-trade chart is cached: a third request makes no new fetch.
    const callsAfterOk = calls;
    await app.request(`/api/trades/${trade.id}/chart`, { headers: { Host: "127.0.0.1:34610" } });
    assert.equal(calls, callsAfterOk);
  });
});

// ── §5.16 item 3: GET /api/reviews.csv (AC-130, AC-131, AC-132) ─────────────────────────────────

test("AC-130: an empty journal returns 200, the right headers, and header row only", async () => {
  await withTempDir(async (dir) => {
    const now = 1_700_000_000_000;
    const { app } = createJournalApp(baseDeps(dir, { now: () => now }, 34620));
    const res = await app.request("/api/reviews.csv", { headers: { Host: "127.0.0.1:34620" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    const expectedDate = new Date(now).toISOString().slice(0, 10);
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="reviews-${expectedDate}.csv"`);
    const body = await res.text();
    assert.equal(body, "tradeId,symbol,side,planId,ruleId,origin,aiStanceAtPlan,entryTime,exitTime,entryPrice,exitPrice,quantity,rMultiple,netPnlUsd,fundingUsd,feesUsd,exitKind,followedPlan,entrySlippagePct,sizeDeviationPct,maePct,mfePct,notes\r\n");
  });
});

test("AC-131: one closed trade produces one row; a note with a comma and a quote is RFC-4180 quoted; an open trade is excluded", async () => {
  await withTempDir(async (dir) => {
    const entryT = 1_700_000_000_000;
    const exitT = entryT + 3_600_000;
    const closedTrade = openPaperTrade({
      id: "closed-1", status: "closed", exitKind: "target", updatedAt: exitT,
      exitFills: [{ execId: "x1", time: exitT, price: 110, qty: 2, feeUsd: 0.22, side: "sell" }],
      notes: 'He said "size down", so I did',
    });
    const openTrade = openPaperTrade({ id: "open-1", planId: null, plannedSnapshot: null });
    saveManualJournal([closedTrade, openTrade], { path: join(dir, "manual-journal.json") });
    const { app } = createJournalApp(baseDeps(dir, {}, 34621));
    const res = await app.request("/api/reviews.csv", { headers: { Host: "127.0.0.1:34621" } });
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2); // header + exactly one data row (the open trade is excluded)
    assert.ok(lines[1]!.startsWith("closed-1,BTC/USDT,long,"));
    assert.ok(lines[1]!.endsWith('"He said ""size down"", so I did"'));
  });
});

test("AC-132: GET /api/reviews.csv with a mismatched Host header returns 403", async () => {
  await withTempDir(async (dir) => {
    const { app } = createJournalApp(baseDeps(dir, {}, 34622));
    const res = await app.request("/api/reviews.csv", { headers: { Host: "evil.example:34622" } });
    assert.equal(res.status, 403);
  });
});
