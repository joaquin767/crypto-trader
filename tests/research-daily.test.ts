// research:daily CLI tests — specs/daily-catalyst-manual-trading.md §5.12, AC-18.
// No test touches the network: every adapter's `fetch` dependency is a stub that always fails,
// so every source resolves to "unavailable" deterministically (features end up "missing",
// completeness "incomplete") without needing per-endpoint fixtures — this file exercises the
// CLI's own orchestration (exit codes, revisioning, rule-set validation gate), not the
// adapters/features/planner logic already covered by their own test files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterDeps } from "../src/research/http.ts";
import {
  decideResearchDailyAction, latestReportRevision, parseResearchDailyArgs, runResearchDaily,
} from "../scripts/research-daily.ts";
import type { NotifySpawnFn, ResearchDailyArgs } from "../scripts/research-daily.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import type { AiAnalystConfig, AiCallResult, AiClientPort } from "../src/research/ai/types.ts";

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

function writeTempConfig(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    exchange: "bybit", apiKey: "k", apiSecret: "s", symbols: ["BTC/USDT"],
    maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 10,
    stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
    ...overrides,
  }));
  return path;
}

/** A fetch stub with enough real market data (daily klines + instrument filters) for
 *  VALID_RULES's "close > 0" condition to actually trigger a rule plan — reused from AC-65's
 *  fixture below (§5.8a wiring section) so AI-channel tests can compare against a real plan
 *  instead of an empty array. */
function priceDataFetchStub(): typeof fetch {
  const dailyBars = (): string[][] => {
    const bars: string[][] = [];
    for (let i = 0; i < 20; i++) {
      const t = Date.UTC(2026, 8, 15, 0, 0, 0) - i * 24 * 60 * 60 * 1000;
      bars.push([String(t), "100", "101", "99", "100", "1000"]);
    }
    return bars;
  };
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/v5/market/kline") && u.includes("interval=D")) {
      return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: dailyBars() } }), { status: 200 });
    }
    if (u.includes("/v5/market/instruments-info")) {
      return new Response(JSON.stringify({
        retCode: 0, retMsg: "OK",
        result: { list: [{ lotSizeFilter: { minOrderQty: "0.0001", qtyStep: "0.0001", minNotionalValue: "5" } }] },
      }), { status: 200 });
    }
    throw new Error("stub network error");
  }) as unknown as typeof fetch;
}

function fakeAiClientFactory(result: AiCallResult): (cfg: AiAnalystConfig, snapshotRoot: string) => AiClientPort {
  return () => ({ analyze: async () => result });
}

function makeArgs(dir: string, overrides: Partial<ResearchDailyArgs> = {}): ResearchDailyArgs {
  return {
    date: "2026-09-16",
    refetch: false,
    // Only write the plain default config when the caller didn't already write (and pass) its
    // own — calling writeTempConfig(dir) unconditionally here would clobber a config a caller
    // wrote with `ai` overrides at the very same path, since writeTempConfig always targets
    // "<dir>/config.json".
    configPath: overrides.configPath ?? writeTempConfig(dir),
    snapshotRoot: join(dir, "snapshots"),
    reportsRoot: join(dir, "reports"),
    rulesPath: join(dir, "research-rules.json"),
    journalPath: join(dir, "manual-journal.json"),
    noAi: false,
    aiLedgerPath: join(dir, "ai-usage.jsonl"),
    aiRulesRoot: join(dir, "ai-rules"),
    promptPath: join(dir, "prompt.md"),
    decisionsRoot: join(dir, "decisions"),
    notify: false,
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

// ── §5.8a journal wiring (AC-64, AC-65) ─────────────────────────────────────────────────────────

function fixtureOpenTrade(id: string, symbol = "BTC/USDT"): ManualTrade {
  return {
    id, venue: "paper", symbol, side: "long", planId: null, ruleId: null, ruleHash: null,
    plannedSnapshot: null, aiStanceAtPlan: null, entryFills: [], exitFills: [],
    actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: NOW, updatedAt: NOW,
  };
}

test("AC-64: no journal file at all runs with 0 open trades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    assert.ok(!existsSync(args.journalPath));
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.report!.openTradeThesis, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-64: a corrupt journal with all backups corrupt exits 5 and writes no report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    writeFileSync(args.journalPath, "not json");
    for (let n = 1; n <= 5; n++) writeFileSync(`${args.journalPath}.bak.${n}`, "also not json");
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 5);
    assert.ok(!existsSync(join(args.reportsRoot, "2026-09-16.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-65: 2 open journal trades and maxOpenManualTrades 3 leave room for at most 1 plan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    writeFileSync(args.journalPath, JSON.stringify([fixtureOpenTrade("t1"), fixtureOpenTrade("t2")]));

    const dailyBars = (): string[][] => {
      const bars: string[][] = [];
      for (let i = 0; i < 20; i++) {
        const t = Date.UTC(2026, 8, 15, 0, 0, 0) - i * 24 * 60 * 60 * 1000;
        bars.push([String(t), "100", "101", "99", "100", "1000"]);
      }
      return bars;
    };
    const fetchStub = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/v5/market/kline") && u.includes("interval=D")) {
        return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: dailyBars() } }), { status: 200 });
      }
      if (u.includes("/v5/market/instruments-info")) {
        return new Response(JSON.stringify({
          retCode: 0, retMsg: "OK",
          result: { list: [{ lotSizeFilter: { minOrderQty: "0.0001", qtyStep: "0.0001", minNotionalValue: "5" } }] },
        }), { status: 200 });
      }
      throw new Error("stub network error");
    }) as unknown as typeof fetch;

    const deps = fakeDeps({
      readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()),
      fetch: fetchStub,
    });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 0);
    const plans = result.report!.plans.filter((p) => p.kind === "plan");
    assert.ok(plans.length <= 1, `expected at most 1 plan, got ${plans.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC-118 (revision 3): persona thesis loaded from data/decisions/ ────────────────────────────

function personaOpenTrade(id: string, planId: string, ruleId: string): ManualTrade {
  return {
    id, venue: "paper", symbol: "BTC/USDT", side: "long", planId, ruleId, ruleHash: ruleId.padEnd(64, "0"),
    plannedSnapshot: null, aiStanceAtPlan: null, entryFills: [], exitFills: [],
    actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: NOW, updatedAt: NOW,
  };
}

function writePersonaDecisionFixture(decisionsRoot: string, date: string, ruleId: string): void {
  mkdirSync(decisionsRoot, { recursive: true });
  const personaRule = {
    id: ruleId, version: 1, description: "d", evidence: [], status: "experimental",
    symbols: ["BTC/USDT"], side: "long", entryWhenAll: [],
    invalidateWhenAny: [{ feature: "close", op: ">", value: 0 }], // priceDataFetchStub's close=100 -> always triggered
    stopAtrMultiple: 2, targetRMultiple: 2, maxHoldDays: 5, forwardOnly: true, origin: "persona",
  };
  const decision = {
    schemaVersion: 1, dateUtc: date, revision: 0, decidedAt: NOW - 86_400_000,
    skillHash: ruleId.padEnd(64, "0"), reportPath: `reports/${date}.json`, reportSha256: "x", reportDecisionTime: NOW - 86_400_000,
    input: { dateUtc: date, choice: { kind: "no-trade", reason: "unused" }, stances: [], news: [], rationale: "r" },
    validation: { ok: true, rejections: [], unverifiedWebRefs: [] },
    plan: null, personaRule, basedOnPlanId: null, basedOnRuleKey: null, ownerProtocol: null,
    ownerTimeZone: "America/Argentina/Buenos_Aires",
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };
  writeFileSync(join(decisionsRoot, `${date}.json`), JSON.stringify(decision));
}

test("AC-118: an open persona-origin trade's thesis is loaded from data/decisions/<date>.json's personaRule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const ruleId = "persona-abcd1234";
    const planId = "2026-09-15:persona-abcd1234:BTC/USDT";
    writeFileSync(args.journalPath, JSON.stringify([personaOpenTrade("pt1", planId, ruleId)]));
    writePersonaDecisionFixture(args.decisionsRoot, "2026-09-15", ruleId);

    const deps = fakeDeps({
      readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()),
      fetch: priceDataFetchStub(),
    });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 0, result.message);
    assert.equal(result.report!.openTradeThesis.length, 1);
    assert.equal(result.report!.openTradeThesis[0]!.tradeId, "pt1");
    assert.equal(result.report!.openTradeThesis[0]!.state, "invalidated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-118: a missing decision file yields not_evaluable, never a guess", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const ruleId = "persona-abcd1234";
    const planId = "2026-09-15:persona-abcd1234:BTC/USDT";
    writeFileSync(args.journalPath, JSON.stringify([personaOpenTrade("pt1", planId, ruleId)]));
    // No data/decisions/2026-09-15.json written at all.

    const deps = fakeDeps({
      readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()),
      fetch: priceDataFetchStub(),
    });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 0, result.message);
    assert.equal(result.report!.openTradeThesis.length, 1);
    assert.equal(result.report!.openTradeThesis[0]!.state, "not_evaluable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── §5.13 AI analyst wiring (AC-40..53) ─────────────────────────────────────────────────────

test("AC-49b: a report left aiAnalyst.status 'pending' exits 3 with the AI-specific message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    mkdirSync(args.reportsRoot, { recursive: true });
    writeFileSync(
      join(args.reportsRoot, "2026-09-16.json"),
      JSON.stringify({ aiAnalyst: { status: "pending", reason: "" } }),
    );
    const deps = fakeDeps({ readFile: () => { throw new Error("must not read the rules file for an exit-3 case"); } });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 3);
    assert.equal(result.message, "AI step incomplete for 2026-09-16; rerun with --refetch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a complete existing report (not pending) still gets the generic exit-3 message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    mkdirSync(args.reportsRoot, { recursive: true });
    writeFileSync(join(args.reportsRoot, "2026-09-16.json"), JSON.stringify({ aiAnalyst: { status: "ok", reason: "" } }));
    const deps = fakeDeps({ readFile: () => { throw new Error("must not read the rules file for an exit-3 case"); } });
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 3);
    assert.ok(result.message?.includes("already exists"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-51 (anthropic-api): no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN -> exits 0 with aiAnalyst.status unavailable, reason no_api_key, no network call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  const savedKey = process.env["ANTHROPIC_API_KEY"];
  const savedToken = process.env["ANTHROPIC_AUTH_TOKEN"];
  delete process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_AUTH_TOKEN"];
  try {
    // provider forced to "anthropic-api" — the production default is "claude-cli" (see the
    // complementary test below), and this test is specifically about the SDK adapter's
    // no-api-key path.
    const args = makeArgs(dir, { configPath: writeTempConfig(dir, { ai: { enabled: true, provider: "anthropic-api" } }) });
    writeFileSync(args.promptPath, "system prompt");
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    // No third argument -> uses the real createAnthropicAiClient default factory. Its own
    // no-api-key check runs before any client is constructed, so `deps.fetch` (which always
    // throws) is never reached for the AI step either.
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report!.aiAnalyst.status, "unavailable");
    assert.ok(result.report!.aiAnalyst.reason.includes("no_api_key"));
  } finally {
    if (savedKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedKey;
    if (savedToken !== undefined) process.env["ANTHROPIC_AUTH_TOKEN"] = savedToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-51 (claude-cli, the default provider): no CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY -> exits 0 with aiAnalyst.status unavailable, reason no_api_key, claude CLI never spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  const savedKey = process.env["ANTHROPIC_API_KEY"];
  const savedToken = process.env["ANTHROPIC_AUTH_TOKEN"];
  const savedOAuth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  delete process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_AUTH_TOKEN"];
  delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  try {
    const args = makeArgs(dir, { configPath: writeTempConfig(dir, { ai: { enabled: true } }) });
    writeFileSync(args.promptPath, "system prompt");
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    // No third argument -> the default factory picks createClaudeCliAiClient for the default
    // provider "claude-cli". Its own no-credential check runs before any process is spawned, so
    // no real `claude` CLI process is ever started by this test.
    const result = await runResearchDaily(args, deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report!.aiAnalyst.status, "unavailable");
    assert.ok(result.report!.aiAnalyst.reason.includes("no_api_key"));
  } finally {
    if (savedKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedKey;
    if (savedToken !== undefined) process.env["ANTHROPIC_AUTH_TOKEN"] = savedToken;
    if (savedOAuth !== undefined) process.env["CLAUDE_CODE_OAUTH_TOKEN"] = savedOAuth;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AI enabled with a verified idea: attaches an ai-analyst plan, persists its rule, appends the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir, { configPath: writeTempConfig(dir, { ai: { enabled: true, maxIdeasPerDay: 3 } }) });
    writeFileSync(args.promptPath, "system prompt");
    const deps = fakeDeps({
      readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()),
      fetch: priceDataFetchStub(),
    });
    const aiResult: AiCallResult = {
      kind: "ok",
      output: {
        regimeSummary: "calm", planAssessments: [], openTradeNotes: [], risks: [], dataGaps: [],
        ideas: [{
          symbol: "BTC/USDT", side: "long", thesis: "t", catalysts: [],
          refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "close", value: 100 }],
          invalidateWhenAny: [], stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 5, confidence: 0.6,
        }],
      },
      webResults: [], usage: { inputTokens: 100, outputTokens: 50, webSearchRequests: 0 },
      servedByModel: "claude-opus-5", rawResponsePath: "/tmp/raw.json",
    };
    const result = await runResearchDaily(args, deps, fakeAiClientFactory(aiResult));
    assert.equal(result.exitCode, 0);
    assert.equal(result.report!.aiAnalyst.status, "ok");
    const aiPlans = result.report!.plans.filter((p) => p.origin === "ai-analyst");
    assert.equal(aiPlans.length, 1);
    assert.ok(existsSync(args.aiLedgerPath), "ledger line should have been appended");
    if (aiPlans[0]!.kind === "plan") {
      assert.ok(existsSync(join(args.aiRulesRoot, `${aiPlans[0]!.planId}.json`)), "AI rule should be persisted write-once");
    }
    // AC-52: the heading appears exactly once and only AI-origin plans render under it.
    assert.equal((result.markdown!.match(/AI analyst channel — forward-only, unvalidated/g) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-41: rule-origin plans are byte-identical between an AI-enabled run and a --no-ai run", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  const dirB = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const ruleOutcome: AiCallResult = {
      kind: "ok",
      output: { regimeSummary: "calm", planAssessments: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [] },
      webResults: [], usage: { inputTokens: 1, outputTokens: 1, webSearchRequests: 0 },
      servedByModel: "claude-opus-5", rawResponsePath: "/tmp/raw.json",
    };
    const argsA = makeArgs(dirA, { configPath: writeTempConfig(dirA, { ai: { enabled: true } }) });
    writeFileSync(argsA.promptPath, "system prompt");
    const depsA = fakeDeps({
      readFile: (p) => (p === argsA.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()),
      fetch: priceDataFetchStub(),
    });
    const withAi = await runResearchDaily(argsA, depsA, fakeAiClientFactory(ruleOutcome));

    const argsB = makeArgs(dirB, { noAi: true });
    const depsB = fakeDeps({
      readFile: (p) => (p === argsB.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()),
      fetch: priceDataFetchStub(),
    });
    const withoutAi = await runResearchDaily(argsB, depsB);

    const rulePlansA = withAi.report!.plans.filter((p) => p.origin === "rules-file");
    const rulePlansB = withoutAi.report!.plans.filter((p) => p.origin === "rules-file");
    assert.deepEqual(rulePlansA, rulePlansB);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ── §5.16 item 2: desktop notification (AC-128, AC-129) ─────────────────────────────────────────

interface FakeSpawnRecord { calls: { command: string; args: string[] }[] }

function fakeSpawn(record: FakeSpawnRecord, opts: { throwSync?: boolean; emitError?: boolean } = {}): NotifySpawnFn {
  return ((command: string, args: readonly string[]) => {
    if (opts.throwSync) throw new Error("spawn failed synchronously");
    record.calls.push({ command, args: [...args] });
    return {
      on(event: string, listener: (err: Error) => void) {
        if (event === "error" && opts.emitError) listener(new Error("ENOENT: notify-send not found"));
      },
    };
  }) as unknown as NotifySpawnFn;
}

test("AC-128: notification disabled (no config flag, no --notify) never calls spawnFn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir);
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const record: FakeSpawnRecord = { calls: [] };
    const result = await runResearchDaily(args, deps, undefined, fakeSpawn(record));
    assert.equal(result.exitCode, 0);
    assert.equal(record.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-128: manual.notifyOnReport true calls spawnFn once with the expected notify-send args", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir, { configPath: writeTempConfig(dir, { manual: { notifyOnReport: true } }) });
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const record: FakeSpawnRecord = { calls: [] };
    const result = await runResearchDaily(args, deps, undefined, fakeSpawn(record));
    assert.equal(result.exitCode, 0);
    assert.equal(record.calls.length, 1);
    assert.equal(record.calls[0]!.command, "notify-send");
    assert.equal(record.calls[0]!.args[0], "crypto-trader");
    assert.equal(record.calls[0]!.args[1], "2026-09-16 report written: 0 rule plans, 0 AI plans, ai disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-128: --notify flag alone (config false) also calls spawnFn once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir, { notify: true });
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const record: FakeSpawnRecord = { calls: [] };
    const result = await runResearchDaily(args, deps, undefined, fakeSpawn(record));
    assert.equal(result.exitCode, 0);
    assert.equal(record.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-129: a synchronously-throwing spawnFn never changes the exit code or the written report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir, { notify: true });
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const result = await runResearchDaily(args, deps, undefined, fakeSpawn({ calls: [] }, { throwSync: true }));
    assert.equal(result.exitCode, 0);
    assert.ok(existsSync(join(args.reportsRoot, "2026-09-16.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-129: a spawnFn whose child emits an 'error' event (missing binary) never changes the exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-daily-test-"));
  try {
    const args = makeArgs(dir, { notify: true });
    const deps = fakeDeps({ readFile: (p) => (p === args.rulesPath ? JSON.stringify(VALID_RULES) : (() => { throw new Error("unexpected path"); })()) });
    const record: FakeSpawnRecord = { calls: [] };
    const result = await runResearchDaily(args, deps, undefined, fakeSpawn(record, { emitError: true }));
    assert.equal(result.exitCode, 0);
    assert.equal(record.calls.length, 1); // spawn was still attempted
    assert.ok(existsSync(join(args.reportsRoot, "2026-09-16.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
