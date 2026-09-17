// Trade analytics tests — specs/daily-catalyst-manual-trading.md §5.9/§5.8a,
// AC-29..34, AC-50.

import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregate, liveView, reviewClosedTrade, reviewsToCsv } from "../src/journal/trade-analytics.ts";
import type { ClosedTradeReview } from "../src/journal/trade-analytics.ts";
import type { SyncResult } from "../src/journal/exchange-sync.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import type { TradePlan } from "../src/research/planner.ts";

function samplePlan(overrides: Partial<Extract<TradePlan, { kind: "plan" }>> = {}): Extract<TradePlan, { kind: "plan" }> {
  return {
    kind: "plan", planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "hash",
    origin: "rules-file", symbol: "BTC/USDT", side: "long",
    referencePrice: 100, stopPrice: 90, targetPrice: 130, expiresAt: 100_000,
    quantity: 1, notionalUsd: 100, riskUsd: 10, leverage: 2, marginUsd: 50,
    estLiquidationPrice: 50, liqToStopRatio: 2, estRoundTripFeeUsd: 0.11,
    venueIntent: "paper", maxHoldDays: 5,
    ...overrides,
  };
}

function openTrade(overrides: Partial<ManualTrade> = {}): ManualTrade {
  return {
    id: "t1", venue: "bybit-live", symbol: "BTC/USDT", side: "long",
    planId: "2026-09-16:r1:BTC/USDT", ruleId: "r1", ruleHash: "hash",
    plannedSnapshot: samplePlan(), aiStanceAtPlan: null,
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1, feeUsd: 0.05, side: "buy" }],
    exitFills: [], actualLeverage: 2, exchangeLiqPrice: 50,
    fundingUsd: 0, status: "open", exitKind: null, notes: "", createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function position(overrides: Partial<SyncResult["positions"][number]> = {}): SyncResult["positions"][number] {
  return { symbol: "BTC/USDT", side: "long", size: 1, avgPrice: 100, leverage: 2, liqPrice: 50, markPrice: 105, unrealisedPnl: 5, ...overrides };
}

// ── liveView (AC-29, AC-30, AC-31, AC-32) ────────────────────────────────────────────────────────

test("AC-29: a sync failure marks the view stale with markPrice/unrealisedPnlUsd null", () => {
  const t = openTrade();
  const now = 200_000;
  const lastSyncAt = 0;
  const view = liveView(t, position(), "intact", now, lastSyncAt, 120_000);
  assert.equal(view.stale, true);
  assert.equal(view.markPrice, null);
  assert.equal(view.unrealisedPnlUsd, null);
  assert.ok(view.alerts.includes("data_stale"));
});

test("liveView is not stale within staleAfterMs", () => {
  const t = openTrade();
  const view = liveView(t, position(), "intact", 100_000, 0, 200_000);
  assert.equal(view.stale, false);
  assert.equal(view.markPrice, 105);
  assert.equal(view.unrealisedPnlUsd, 5);
});

test("AC-30: an unplanned trade has planId null and the unplanned alert", () => {
  const t = openTrade({ planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null });
  const view = liveView(t, null, "not_evaluable", 100_000, 0, 200_000);
  assert.ok(view.alerts.includes("unplanned"));
});

test("AC-31: exchangeLiqPrice closer to entry than the plan's stop sets stop_beyond_liquidation", () => {
  const t = openTrade({ exchangeLiqPrice: 95 }); // stop is 90; liq 95 sits between entry(100) and stop -> closer to entry
  const view = liveView(t, position({ liqPrice: 95 }), "intact", 100_000, 0, 200_000);
  // liqBeyondStop reports the SAFE ordering (liquidation further out than the stop); here it's
  // the opposite (liquidation would trigger before the stop), so it's false and the alert fires.
  assert.equal(view.liqBeyondStop, false);
  assert.ok(view.alerts.includes("stop_beyond_liquidation"));
});

test("AC-32: size deviating from plan by >10% sets size_deviates_from_plan", () => {
  const t = openTrade({ entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1.2, feeUsd: 0, side: "buy" }] });
  const view = liveView(t, position(), "intact", 100_000, 0, 200_000);
  assert.ok(view.alerts.includes("size_deviates_from_plan"));
});

test("AC-32: actualLeverage exceeding plan.leverage sets leverage_exceeds_plan", () => {
  const t = openTrade({ actualLeverage: 3 }); // plan leverage is 2
  const view = liveView(t, position(), "intact", 100_000, 0, 200_000);
  assert.ok(view.alerts.includes("leverage_exceeds_plan"));
});

test("liveView: thesis_invalidated and expired alerts", () => {
  const t = openTrade({
    plannedSnapshot: samplePlan({ maxHoldDays: 1 }),
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
  });
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const view = liveView(t, position(), "invalidated", twoDaysMs, twoDaysMs, 200_000);
  assert.ok(view.alerts.includes("thesis_invalidated"));
  assert.ok(view.alerts.includes("expired"));
  assert.ok(view.hoursToExpiry! < 0);
});

// ── reviewClosedTrade (AC-33) ─────────────────────────────────────────────────────────────────

test("AC-33: netPnl -1.10 over plannedRisk 1.00 gives rMultiple -1.1", () => {
  const t = openTrade({
    plannedSnapshot: samplePlan({ riskUsd: 1.0 }),
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [{ execId: "x1", time: 1, price: 98.9, qty: 1, feeUsd: 0, side: "sell" }],
    status: "closed", exitKind: "stop",
  });
  const review = reviewClosedTrade(t, []);
  assert.ok(Math.abs(review.netPnlUsd - -1.1) < 1e-9);
  assert.ok(Math.abs(review.rMultiple! - -1.1) < 1e-9);
});

test("reviewClosedTrade: unplanned trade has null plannedRiskUsd/rMultiple", () => {
  const t = openTrade({
    planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null,
    entryFills: [{ execId: "e1", time: 0, price: 100, qty: 1, feeUsd: 0, side: "buy" }],
    exitFills: [{ execId: "x1", time: 1, price: 105, qty: 1, feeUsd: 0, side: "sell" }],
    status: "closed", exitKind: "unknown",
  });
  const review = reviewClosedTrade(t, []);
  assert.equal(review.plannedRiskUsd, null);
  assert.equal(review.rMultiple, null);
});

// ── aggregate (AC-34, AC-50) ──────────────────────────────────────────────────────────────────

function review(overrides: Partial<ClosedTradeReview> = {}): ClosedTradeReview {
  return {
    tradeId: "t", ruleId: "r1", ruleHash: "hash12345678", origin: "rules-file", aiStanceAtPlan: null,
    basedOnRuleKey: null,
    plannedRiskUsd: 1, netPnlUsd: 0, feesUsd: 0, fundingUsd: 0, rMultiple: 0,
    entrySlippagePct: null, sizeDeviationPct: null, maePct: 0, mfePct: 0,
    exitKind: "target", followedPlan: true,
    ...overrides,
  };
}

test("AC-34: aggregate never blends venues (caller passes single-venue reviews)", () => {
  const paperReviews = [review({ tradeId: "p1", netPnlUsd: 5, rMultiple: 1 })];
  const stats = aggregate(paperReviews, "paper");
  assert.equal(stats.venue, "paper");
  assert.equal(stats.closedTrades, 1);
  assert.equal(stats.totalNetPnlUsd, 5);
});

test("AC-50: byAiStance groups rule-origin trades by AI stance, excludes AI-origin trades", () => {
  const reviews: ClosedTradeReview[] = [
    review({ tradeId: "a", aiStanceAtPlan: "support", rMultiple: 1, netPnlUsd: 1 }),
    review({ tradeId: "b", aiStanceAtPlan: "support", rMultiple: 2, netPnlUsd: 2 }),
    review({ tradeId: "c", aiStanceAtPlan: "oppose", rMultiple: -1, netPnlUsd: -1 }),
    review({ tradeId: "d", aiStanceAtPlan: null, rMultiple: 0.5, netPnlUsd: 0.5 }),
    review({ tradeId: "e", origin: "ai-analyst", ruleId: "ai-analyst-abcd1234", aiStanceAtPlan: null, rMultiple: 99, netPnlUsd: 99 }),
  ];
  const stats = aggregate(reviews, "bybit-live");
  assert.deepEqual(stats.byAiStance.support, { closed: 2, expectancyR: 1.5, winRate: 1 });
  assert.deepEqual(stats.byAiStance.oppose, { closed: 1, expectancyR: -1, winRate: 0 });
  assert.equal(stats.byAiStance.caution.closed, 0);
  assert.equal(stats.byAiStance.none.closed, 1);
  // the AI-origin review never appears in any byAiStance bucket
  const totalStanceClosed = Object.values(stats.byAiStance).reduce((sum, b) => sum + b.closed, 0);
  assert.equal(totalStanceClosed, 4);
});

test("§5.9 byRule keys by <ruleId>@<first 8 chars of ruleHash>, so rule versions never blend", () => {
  const reviews: ClosedTradeReview[] = [
    review({ tradeId: "a", ruleId: "r1", ruleHash: "aaaaaaaa11111111", netPnlUsd: 1, rMultiple: 1 }),
    review({ tradeId: "b", ruleId: "r1", ruleHash: "aaaaaaaa11111111", netPnlUsd: 3, rMultiple: 3 }),
    review({ tradeId: "c", ruleId: "r1", ruleHash: "bbbbbbbb22222222", netPnlUsd: -1, rMultiple: -1 }),
    review({ tradeId: "d", ruleId: null, ruleHash: null, netPnlUsd: 100, rMultiple: 100 }), // unplanned, skipped
  ];
  const stats = aggregate(reviews, "paper");
  assert.deepEqual(Object.keys(stats.byRule).sort(), ["r1@aaaaaaaa", "r1@bbbbbbbb"].sort());
  assert.equal(stats.byRule["r1@aaaaaaaa"]!.closed, 2);
  assert.equal(stats.byRule["r1@aaaaaaaa"]!.netPnlUsd, 4);
  assert.equal(stats.byRule["r1@bbbbbbbb"]!.closed, 1);
  assert.equal(stats.byRule["r1@bbbbbbbb"]!.netPnlUsd, -1);
});

test("aggregate: byOrigin separates rules-file from ai-analyst", () => {
  const reviews: ClosedTradeReview[] = [
    review({ tradeId: "a", origin: "rules-file", netPnlUsd: 1, rMultiple: 1 }),
    review({ tradeId: "b", origin: "ai-analyst", ruleId: "ai-analyst-abcd1234", netPnlUsd: 2, rMultiple: 2 }),
  ];
  const stats = aggregate(reviews, "paper");
  assert.equal(stats.byOrigin["rules-file"].closed, 1);
  assert.equal(stats.byOrigin["ai-analyst"].closed, 1);
});

test("revision 3: byOrigin.persona and chosenByPersona are always present and zero-filled when empty", () => {
  const stats = aggregate([], "paper");
  assert.deepEqual(stats.byOrigin.persona, { closed: 0, expectancyR: null, netPnlUsd: 0 });
  assert.deepEqual(stats.chosenByPersona, {});
});

test("revision 3: chosenByPersona groups closed persona-origin trades by basedOnRuleKey; a persona's own idea (no basedOnRuleKey) is not counted", () => {
  const reviews: ClosedTradeReview[] = [
    review({ tradeId: "p1", origin: "persona", ruleId: "persona-3f9a1c2b", ruleHash: "h".repeat(64), basedOnRuleKey: "etf-flow-momentum@aaaaaaaa", netPnlUsd: 5, rMultiple: 1.5 }),
    review({ tradeId: "p2", origin: "persona", ruleId: "persona-3f9a1c2b", ruleHash: "h".repeat(64), basedOnRuleKey: "etf-flow-momentum@aaaaaaaa", netPnlUsd: -2, rMultiple: -0.5 }),
    review({ tradeId: "p3", origin: "persona", ruleId: "persona-3f9a1c2b", ruleHash: "h".repeat(64), basedOnRuleKey: null, netPnlUsd: 3, rMultiple: 1 }),
  ];
  const stats = aggregate(reviews, "paper");
  assert.equal(stats.byOrigin.persona.closed, 3);
  assert.equal(Object.keys(stats.chosenByPersona).length, 1);
  const key = stats.chosenByPersona["etf-flow-momentum@aaaaaaaa"]!;
  assert.equal(key.closed, 2);
  assert.equal(key.netPnlUsd, 3);
  assert.ok(Math.abs(key.expectancyR! - 0.5) < 1e-9);
});

// ── §5.16 item 3: reviewsToCsv ──────────────────────────────────────────────────────────────────

test("reviewsToCsv: header row only for an empty list", () => {
  const csv = reviewsToCsv([]);
  assert.equal(csv, "tradeId,symbol,side,planId,ruleId,origin,aiStanceAtPlan,entryTime,exitTime,entryPrice,exitPrice,quantity,rMultiple,netPnlUsd,fundingUsd,feesUsd,exitKind,followedPlan,entrySlippagePct,sizeDeviationPct,maePct,mfePct,notes\r\n");
});

test("reviewsToCsv: one data row matches the trade and its review, RFC 4180 quoting on a comma+quote note", () => {
  const trade = openTrade({
    id: "t1", venue: "paper", status: "closed", exitKind: "target",
    entryFills: [{ execId: "e1", time: 1_700_000_000_000, price: 100, qty: 1, feeUsd: 0.05, side: "buy" }],
    exitFills: [{ execId: "x1", time: 1_700_003_600_000, price: 110, qty: 1, feeUsd: 0.06, side: "sell" }],
    notes: 'He said "size down", so I did',
  });
  const review = reviewClosedTrade(trade, []);
  const csv = reviewsToCsv([{ trade, review }]);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 3); // header + 1 row + trailing empty string after the final \r\n
  const cols = lines[1]!.split(",");
  assert.equal(cols[0], "t1");
  assert.equal(cols[1], "BTC/USDT");
  assert.equal(cols[2], "long");
  assert.equal(cols[7], new Date(1_700_000_000_000).toISOString());
  assert.equal(cols[8], new Date(1_700_003_600_000).toISOString());
  // The notes field contains a comma and a double quote, so it must be quoted with the internal
  // quote doubled — split(",") above would otherwise have split it into extra columns, so its
  // exact rendering is checked directly against the raw line instead.
  assert.ok(lines[1]!.endsWith('"He said ""size down"", so I did"'));
});
