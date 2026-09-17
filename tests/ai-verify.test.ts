// verifyAiOutput tests — specs/daily-catalyst-manual-trading.md §5.13, AC-42..45.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { FeatureValue, FeatureVector } from "../src/research/types.ts";
import type { TradePlan } from "../src/research/planner.ts";
import type { AiAnalystInput, AiAnalystOutput, AiIdea } from "../src/research/ai/types.ts";
import { verifyAiOutput } from "../src/research/ai/verify.ts";

function fv(symbol: string, overrides: Partial<Record<string, number>> = {}): FeatureVector {
  const missing = (): FeatureValue => ({ kind: "missing", reason: "n/a", sourceId: "bybit-klines-1d" });
  const value = (v: number): FeatureValue => ({ kind: "value", value: v, availableAt: 0, sourceId: "bybit-klines-1d" });
  return {
    symbol, decisionTime: 0,
    features: {
      close: overrides["close"] !== undefined ? value(overrides["close"]) : value(60000),
      return1d: missing(), return7d: missing(), atr14d: value(1000), realizedVol7d: missing(),
      fundingRate8hAvg3d: overrides["fundingRate8hAvg3d"] !== undefined ? value(overrides["fundingRate8hAvg3d"]) : value(0.0003),
      fundingRatePercentile90d: missing(), oiChange3dPct: missing(),
      btcEtfNetFlowUsd1d: missing(), btcEtfNetFlowUsd5d: missing(), ethEtfNetFlowUsd1d: missing(),
      stablecoinSupplyChange7dPct: missing(), fearGreed: missing(),
      hoursToNextFomc: missing(), hoursToNextCpi: missing(), daysToNextUnlock: missing(), nextUnlockPctOfFloat: missing(),
    },
  };
}

const RULE_PLAN: Extract<TradePlan, { kind: "plan" }> = {
  kind: "plan", planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "h1", origin: "rules-file",
  symbol: "BTC/USDT", side: "long", referencePrice: 60000, stopPrice: 58000, targetPrice: 66000,
  expiresAt: 1_000_000, quantity: 0.01, notionalUsd: 600, riskUsd: 20, leverage: 1, marginUsd: 600,
  estLiquidationPrice: 30000, liqToStopRatio: 15, estRoundTripFeeUsd: 0.66, venueIntent: "paper", maxHoldDays: 5,
};

function input(overrides: Partial<AiAnalystInput> = {}): AiAnalystInput {
  return {
    dateUtc: "2026-09-16", decisionTime: 0, promptVersionHash: "hash", systemPrompt: "sp",
    sources: [], features: [fv("BTC/USDT")], outcomes: [], rulePlans: [RULE_PLAN],
    openTrades: [{ tradeId: "t1", symbol: "BTC/USDT", side: "long", ruleId: "r1", thesis: "intact", heldHours: 1, unrealisedR: null }],
    configSymbols: ["BTC/USDT", "ETH/USDT"],
    ...overrides,
  };
}

function idea(overrides: Partial<AiIdea> = {}): AiIdea {
  return {
    symbol: "BTC/USDT", side: "long", thesis: "t", catalysts: [],
    refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "fundingRate8hAvg3d", value: 0.0003 }],
    invalidateWhenAny: [], stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 5, confidence: 0.6,
    ...overrides,
  };
}

function output(overrides: Partial<AiAnalystOutput> = {}): AiAnalystOutput {
  return { regimeSummary: "calm", planAssessments: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], ...overrides };
}

// ── AC-42: unverifiable feature ref ─────────────────────────────────────────────────────────

test("AC-42: an idea citing a feature value that differs from the snapshot is dropped as unverifiable_feature", () => {
  const out = output({
    ideas: [idea({ refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "fundingRate8hAvg3d", value: 0.0002 }] })],
  });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.deepEqual(verified.ideas, []);
  assert.deepEqual(rejected, [{ path: "ideas[0]", reason: "unverifiable_feature" }]);
});

test("a feature ref matching the snapshot exactly is kept", () => {
  const out = output({ ideas: [idea()] });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.equal(verified.ideas.length, 1);
  assert.deepEqual(rejected, []);
});

// ── AC-43: web refs ──────────────────────────────────────────────────────────────────────────

test("AC-43: a web ref citing a URL not in webResults is rejected unverifiable_web; present is kept", () => {
  const badOut = output({ ideas: [idea({ refs: [{ kind: "web", url: "https://example.com/a" }] })] });
  const bad = verifyAiOutput(badOut, input(), [{ url: "https://example.com/b" }], 3);
  assert.deepEqual(bad.output.ideas, []);
  assert.deepEqual(bad.rejected, [{ path: "ideas[0]", reason: "unverifiable_web" }]);

  const goodOut = output({ ideas: [idea({ refs: [{ kind: "web", url: "https://example.com/a" }] })] });
  const good = verifyAiOutput(goodOut, input(), [{ url: "https://example.com/a" }], 3);
  assert.equal(good.output.ideas.length, 1);
  assert.deepEqual(good.rejected, []);
});

// ── AC-44: unknown_plan / symbol_not_configured / no_evidence ───────────────────────────────

test("AC-44: an assessment for a planId not in rulePlans is rejected unknown_plan", () => {
  const out = output({
    planAssessments: [{ planId: "does-not-exist", stance: "support", confidence: 0.7, reasons: [{ text: "x", refs: [] }] }],
  });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.deepEqual(verified.planAssessments, []);
  assert.deepEqual(rejected, [{ path: "planAssessments[0]", reason: "unknown_plan" }]);
});

test("a valid planId assessment with a verifying reason is kept", () => {
  const out = output({
    planAssessments: [{
      planId: RULE_PLAN.planId, stance: "support", confidence: 0.7,
      reasons: [{ text: "funding supports long", refs: [{ kind: "feature", symbol: "BTC/USDT", feature: "fundingRate8hAvg3d", value: 0.0003 }] }],
    }],
  });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.equal(verified.planAssessments.length, 1);
  assert.deepEqual(rejected, []);
});

test("AC-44: an idea on a symbol not in configSymbols is rejected symbol_not_configured", () => {
  const out = output({ ideas: [idea({ symbol: "SOL/USDT" })] });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.deepEqual(verified.ideas, []);
  assert.deepEqual(rejected, [{ path: "ideas[0]", reason: "symbol_not_configured" }]);
});

test("AC-44: an idea with zero refs is rejected no_evidence", () => {
  const out = output({ ideas: [idea({ refs: [] })] });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.deepEqual(verified.ideas, []);
  assert.deepEqual(rejected, [{ path: "ideas[0]", reason: "no_evidence" }]);
});

// ── AC-45: maxIdeas cap ──────────────────────────────────────────────────────────────────────

test("AC-45: 5 verified ideas and maxIdeasPerDay 3 keeps exactly the first 3, rejects 2 over_limit", () => {
  // Distinct symbols so the maxIdeas cap (not the runAiAnalyst-level symbol dedupe, a separate
  // step) is what's under test — configSymbols must cover every symbol used.
  const out = output({
    ideas: [
      idea({ symbol: "BTC/USDT" }), idea({ symbol: "ETH/USDT" }), idea({ symbol: "SOL/USDT" }),
      idea({ symbol: "AVAX/USDT" }), idea({ symbol: "ADA/USDT" }),
    ],
  });
  const wideInput = input({ configSymbols: ["BTC/USDT", "ETH/USDT", "SOL/USDT", "AVAX/USDT", "ADA/USDT"] });
  const { output: verified, rejected } = verifyAiOutput(out, wideInput, [], 3);
  assert.equal(verified.ideas.length, 3);
  assert.deepEqual(verified.ideas.map((i) => i.symbol), ["BTC/USDT", "ETH/USDT", "SOL/USDT"]);
  assert.deepEqual(rejected, [
    { path: "ideas[3]", reason: "over_limit" },
    { path: "ideas[4]", reason: "over_limit" },
  ]);
});

// ── openTradeNotes ───────────────────────────────────────────────────────────────────────────

test("an open-trade note for an unknown tradeId is rejected unknown_trade", () => {
  const out = output({ openTradeNotes: [{ tradeId: "nope", note: "n", refs: [] }] });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.deepEqual(verified.openTradeNotes, []);
  assert.deepEqual(rejected, [{ path: "openTradeNotes[0]", reason: "unknown_trade" }]);
});

// ── out_of_range ─────────────────────────────────────────────────────────────────────────────

test("an idea with an out-of-range numeric field is rejected out_of_range", () => {
  const out = output({ ideas: [idea({ confidence: 1.5 })] });
  const { output: verified, rejected } = verifyAiOutput(out, input(), [], 3);
  assert.deepEqual(verified.ideas, []);
  assert.deepEqual(rejected, [{ path: "ideas[0]", reason: "out_of_range" }]);
});

test("an idea whose between condition is not a [lo, hi] pair with lo <= hi is rejected out_of_range", () => {
  const bad = output({ ideas: [idea({ invalidateWhenAny: [{ feature: "fearGreed", op: "between", value: [80, 20] }] })] });
  const { output: verified, rejected } = verifyAiOutput(bad, input(), [], 3);
  assert.deepEqual(verified.ideas, []);
  assert.deepEqual(rejected, [{ path: "ideas[0]", reason: "out_of_range" }]);

  const scalarForBetween = output({ ideas: [idea({ invalidateWhenAny: [{ feature: "fearGreed", op: "between", value: 50 }] })] });
  assert.deepEqual(verifyAiOutput(scalarForBetween, input(), [], 3).rejected, [{ path: "ideas[0]", reason: "out_of_range" }]);

  const good = output({ ideas: [idea({ invalidateWhenAny: [{ feature: "fearGreed", op: "between", value: [20, 80] }, { feature: "fearGreed", op: ">", value: 90 }] })] });
  assert.equal(verifyAiOutput(good, input(), [], 3).output.ideas.length, 1);
});
