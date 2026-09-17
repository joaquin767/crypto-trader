// AI analyst orchestration tests — specs/daily-catalyst-manual-trading.md §5.13,
// §6.8 AC-40, AC-41, AC-46, AC-47, AC-48, AC-49. All tests use a fake AiClientPort; none touch
// the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FeatureValue, FeatureVector } from "../src/research/types.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "../src/research/planner.ts";
import type { AiAnalystConfig, AiAnalystInput, AiCallResult, AiClientPort, AiIdea } from "../src/research/ai/types.ts";
import { aiIdeaToRule, buildAiAnalystInput, promptVersionHash, runAiAnalyst } from "../src/research/ai/analyst.ts";
import { AI_OUTPUT_JSON_SCHEMA } from "../src/research/ai/output-schema.ts";

const NOW = Date.UTC(2026, 8, 16, 1, 0, 0);

const CFG: PlannerConfig = {
  maxCapitalUsd: 100, riskPerTradePercent: 1, maxLeverage: 5, liveLadderCap: 2,
  marginBudgetPercent: 25, maintenanceMarginRate: 0.005, minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11, maxOpenManualTrades: 3,
};

const INSTRUMENT: InstrumentFilter = { minOrderQty: 0.0001, qtyStep: 0.0001, minNotionalValue: 5 };

function fv(symbol: string, close = 60000, atr14d = 1000): FeatureVector {
  const missing = (): FeatureValue => ({ kind: "missing", reason: "n/a", sourceId: "bybit-klines-1d" });
  return {
    symbol, decisionTime: 0,
    features: {
      close: { kind: "value", value: close, availableAt: 0, sourceId: "bybit-klines-1d" },
      atr14d: { kind: "value", value: atr14d, availableAt: 0, sourceId: "bybit-klines-1d" },
      return1d: missing(), return7d: missing(), realizedVol7d: missing(),
      fundingRate8hAvg3d: missing(), fundingRatePercentile90d: missing(), oiChange3dPct: missing(),
      btcEtfNetFlowUsd1d: missing(), btcEtfNetFlowUsd5d: missing(), ethEtfNetFlowUsd1d: missing(),
      stablecoinSupplyChange7dPct: missing(), fearGreed: missing(),
      hoursToNextFomc: missing(), hoursToNextCpi: missing(), daysToNextUnlock: missing(), nextUnlockPctOfFloat: missing(),
    },
  };
}

function aiCfg(overrides: Partial<AiAnalystConfig> = {}): AiAnalystConfig {
  return {
    enabled: true, model: "claude-opus-5", effort: "high", maxTokens: 32_000, webSearchMaxUses: 5,
    maxIdeasPerDay: 3, monthlyBudgetUsd: 15, inputUsdPerMTok: 5, outputUsdPerMTok: 25,
    webSearchUsdPerRequest: 0.01, channelStatus: "experimental", passedPromptHash: null, timeoutMs: 600_000,
    ...overrides,
  };
}

function aiInput(overrides: Partial<AiAnalystInput> = {}): AiAnalystInput {
  return {
    dateUtc: "2026-09-16", decisionTime: 0, promptVersionHash: "hash", systemPrompt: "sp",
    sources: [], features: [fv("BTC/USDT")], outcomes: [], rulePlans: [], openTrades: [],
    configSymbols: ["BTC/USDT"],
    ...overrides,
  };
}

function idea(overrides: Partial<AiIdea> = {}): AiIdea {
  return {
    symbol: "BTC/USDT", side: "long", thesis: "t", catalysts: [],
    refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "atr14d", value: 1000 }],
    invalidateWhenAny: [], stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 5, confidence: 0.6,
    ...overrides,
  };
}

function fakePort(result: AiCallResult): AiClientPort & { calls: AiAnalystInput[] } {
  const calls: AiAnalystInput[] = [];
  return {
    calls,
    analyze: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ai-analyst-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function plannerBag(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    cfg: CFG, openTradeCount: 0, breakerTripped: false, dateUtc: "2026-09-16",
    features: [fv("BTC/USDT")], liveClosedTradesForAi: 0, ladderResetByBreaker: true,
    ledgerPath: join(dir, "ai-usage.jsonl"), now: NOW,
    instruments: { "BTC/USDT": INSTRUMENT } as Record<string, InstrumentFilter | null>,
    aiRulesRoot: join(dir, "ai-rules"),
    ...overrides,
  };
}

// ── promptVersionHash (AC-49) ────────────────────────────────────────────────────────────────

test("AC-49: promptVersionHash changes with system prompt, schema, model, effort, maxTokens, webSearchMaxUses, maxIdeasPerDay", () => {
  const base = promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg());
  assert.notEqual(promptVersionHash("prompt v2", AI_OUTPUT_JSON_SCHEMA, aiCfg()), base);
  assert.notEqual(promptVersionHash("prompt v1", `${AI_OUTPUT_JSON_SCHEMA}x`, aiCfg()), base);
  assert.notEqual(promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg({ model: "other" })), base);
  assert.notEqual(promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg({ effort: "low" })), base);
  assert.notEqual(promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg({ maxTokens: 1000 })), base);
  assert.notEqual(promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg({ webSearchMaxUses: 0 })), base);
  assert.notEqual(promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg({ maxIdeasPerDay: 1 })), base);
});

test("AC-49: promptVersionHash is identical across monthlyBudgetUsd, pricing, timeoutMs, channelStatus, passedPromptHash", () => {
  const base = promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg());
  const changed = promptVersionHash("prompt v1", AI_OUTPUT_JSON_SCHEMA, aiCfg({
    monthlyBudgetUsd: 999, inputUsdPerMTok: 1, outputUsdPerMTok: 1, webSearchUsdPerRequest: 1,
    timeoutMs: 1, channelStatus: "paper-passed", passedPromptHash: "whatever",
  }));
  assert.equal(changed, base);
});

// ── aiIdeaToRule (AC-46) ─────────────────────────────────────────────────────────────────────

test("AC-46: experimental channelStatus -> rule status experimental", () => {
  const rule = aiIdeaToRule(idea(), "abcd1234ffff", aiCfg({ channelStatus: "experimental" }));
  assert.equal(rule.status, "experimental");
  assert.equal(rule.id, "ai-analyst-abcd1234");
  assert.equal(rule.forwardOnly, true);
  assert.equal(rule.origin, "ai-analyst");
  assert.deepEqual(rule.entryWhenAll, []);
  assert.deepEqual(rule.evidence, []);
});

test("AC-46: paper-passed channelStatus with a mismatched passedPromptHash -> still experimental", () => {
  const rule = aiIdeaToRule(idea(), "abcd1234ffff", aiCfg({ channelStatus: "paper-passed", passedPromptHash: "different-hash" }));
  assert.equal(rule.status, "experimental");
});

test("paper-passed channelStatus with a matching passedPromptHash -> paper-passed", () => {
  const rule = aiIdeaToRule(idea(), "abcd1234ffff", aiCfg({ channelStatus: "paper-passed", passedPromptHash: "abcd1234ffff" }));
  assert.equal(rule.status, "paper-passed");
});

// ── runAiAnalyst: failures (AC-40) ───────────────────────────────────────────────────────────

const FAILURE_REASONS: Extract<AiCallResult, { kind: "failed" }>["reason"][] =
  ["no_api_key", "api_error", "rate_limited", "timeout", "refusal", "max_tokens", "schema_invalid"];

for (const reason of FAILURE_REASONS) {
  test(`AC-40: a "${reason}" failure yields status unavailable with the reason, no plans/assessments`, async () => {
    await withTempDir(async (dir) => {
      const port = fakePort({ kind: "failed", reason, detail: "boom", usage: null });
      const section = await runAiAnalyst(aiInput(), port, aiCfg(), plannerBag(dir));
      assert.equal(section.status, "unavailable");
      assert.ok(section.reason.includes(reason), `expected reason to include "${reason}", got "${section.reason}"`);
      assert.deepEqual(section.plans, []);
      assert.deepEqual(section.assessments, []);
    });
  });
}

// ── AC-41: runAiAnalyst never mutates the rule plans it was given ──────────────────────────

test("AC-41: runAiAnalyst never mutates input.rulePlans", async () => {
  await withTempDir(async (dir) => {
    const rulePlan: Extract<TradePlan, { kind: "plan" }> = {
      kind: "plan", planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "h1", origin: "rules-file",
      symbol: "BTC/USDT", side: "long", referencePrice: 60000, stopPrice: 58000, targetPrice: 66000,
      expiresAt: 1_000_000, quantity: 0.01, notionalUsd: 600, riskUsd: 20, leverage: 1, marginUsd: 600,
      estLiquidationPrice: 30000, liqToStopRatio: 15, estRoundTripFeeUsd: 0.66, venueIntent: "paper", maxHoldDays: 5,
    };
    const before = JSON.parse(JSON.stringify(rulePlan));
    const input = aiInput({ rulePlans: [rulePlan] });
    const port = fakePort({
      kind: "ok",
      output: { regimeSummary: "calm", planAssessments: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [] },
      webResults: [], usage: { inputTokens: 100, outputTokens: 50, webSearchRequests: 0 },
      servedByModel: "claude-opus-5", rawResponsePath: "/tmp/x.json",
    });
    await runAiAnalyst(input, port, aiCfg(), plannerBag(dir));
    assert.deepEqual(rulePlan, before);
  });
});

// ── AC-47: budget skip ───────────────────────────────────────────────────────────────────────

test("AC-47: month-to-date spend >= budget skips the call entirely", async () => {
  await withTempDir(async (dir) => {
    const cfg = aiCfg({ monthlyBudgetUsd: 1 });
    const bag = plannerBag(dir);
    const { appendLedgerLine } = await import("../src/research/ai/budget.ts");
    appendLedgerLine(bag.ledgerPath, {
      time: NOW, dateUtc: "2026-09-16", model: cfg.model,
      usage: { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 }, costUsd: 5, resultKind: "ok",
    });
    const port = fakePort({ kind: "failed", reason: "api_error", detail: "should never be called", usage: null });
    const section = await runAiAnalyst(aiInput(), port, cfg, bag);
    assert.equal(section.status, "skipped_budget");
    assert.equal(port.calls.length, 0);
  });
});

// ── AC-48: a failed result carrying usage appends one ledger line ───────────────────────────

test("AC-48: a failed result with usage appends one ledger line with resultKind failed", async () => {
  await withTempDir(async (dir) => {
    const bag = plannerBag(dir);
    const port = fakePort({ kind: "failed", reason: "schema_invalid", detail: "bad json", usage: { inputTokens: 10, outputTokens: 5, webSearchRequests: 1 } });
    await runAiAnalyst(aiInput(), port, aiCfg(), bag);
    const lines = readFileSync(bag.ledgerPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.resultKind, "failed");
    assert.deepEqual(entry.usage, { inputTokens: 10, outputTokens: 5, webSearchRequests: 1 });
  });
});

test("a failed result with no usage (e.g. no_api_key) appends no ledger line", async () => {
  await withTempDir(async (dir) => {
    const bag = plannerBag(dir);
    const port = fakePort({ kind: "failed", reason: "no_api_key", detail: "no key", usage: null });
    await runAiAnalyst(aiInput(), port, aiCfg(), bag);
    assert.equal(existsSyncSafe(bag.ledgerPath), false);
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

// ── happy path: verified idea becomes a plan, persists its rule write-once ─────────────────

test("a verified idea produces exactly one plan and persists its rule to data/ai-rules", async () => {
  await withTempDir(async (dir) => {
    const bag = plannerBag(dir);
    const port = fakePort({
      kind: "ok",
      output: { regimeSummary: "calm", planAssessments: [], ideas: [idea()], openTradeNotes: [], risks: [], dataGaps: [] },
      webResults: [], usage: { inputTokens: 100, outputTokens: 50, webSearchRequests: 0 },
      servedByModel: "claude-opus-5", rawResponsePath: "/tmp/x.json",
    });
    const section = await runAiAnalyst(aiInput(), port, aiCfg(), bag);
    assert.equal(section.status, "ok");
    assert.equal(section.plans.length, 1);
    assert.equal(section.plans[0]!.origin, "ai-analyst");
    if (section.plans[0]!.kind === "plan") {
      const rulePath = join(bag.aiRulesRoot, `${section.plans[0]!.planId}.json`);
      const rule = JSON.parse(readFileSync(rulePath, "utf-8"));
      assert.equal(rule.origin, "ai-analyst");
    }
  });
});

// ── buildAiAnalystInput ──────────────────────────────────────────────────────────────────────

test("buildAiAnalystInput maps open trades with thesis from openTradeThesis and null unrealisedR", () => {
  const input = buildAiAnalystInput({
    dateUtc: "2026-09-16", decisionTime: 0, promptVersionHash: "h", systemPrompt: "sp",
    sources: [], features: [fv("BTC/USDT")], outcomes: [], rulePlans: [], configSymbols: ["BTC/USDT"],
    openTrades: [{
      id: "t1", venue: "paper", symbol: "BTC/USDT", side: "long", planId: null, ruleId: "r1", ruleHash: "h1",
      plannedSnapshot: null, aiStanceAtPlan: null, entryFills: [{ execId: "e1", time: NOW - 3_600_000, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
      exitFills: [], actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0, status: "open", exitKind: null,
      notes: "", createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000,
    }],
    openTradeThesis: [{ tradeId: "t1", ruleId: "r1", state: "intact" }],
    now: NOW,
  });
  assert.equal(input.openTrades.length, 1);
  assert.equal(input.openTrades[0]!.thesis, "intact");
  assert.equal(input.openTrades[0]!.unrealisedR, null);
  assert.ok(Math.abs(input.openTrades[0]!.heldHours - 1) < 1e-9);
});

test("AI_OUTPUT_JSON_SCHEMA is the SDK-transformed schema: no keywords the structured-outputs API rejects", () => {
  const schema = JSON.parse(AI_OUTPUT_JSON_SCHEMA) as Record<string, unknown>;
  assert.equal(schema["$schema"], undefined);
  assert.equal(AI_OUTPUT_JSON_SCHEMA.includes("prefixItems"), false);
  assert.equal(AI_OUTPUT_JSON_SCHEMA.includes('"items":false'), false);
  assert.equal(schema["additionalProperties"], false);
  assert.deepEqual(schema["required"], ["regimeSummary", "planAssessments", "ideas", "openTradeNotes", "risks", "dataGaps"]);
});
