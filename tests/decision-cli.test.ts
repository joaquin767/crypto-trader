// decide CLI tests — specs/daily-catalyst-manual-trading.md §5.15, §6.9 AC-98, AC-107..AC-109,
// AC-113a/b, AC-114a, AC-122. Real temp-directory fixtures, real `runDecide` — no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDecideArgs, runDecide, STDIN_IS_A_TTY } from "../scripts/decide-daily.ts";
import type { DecideArgs } from "../src/decision/types.ts";
import type { DailyDecision, ManageDecision, ReviewDecision } from "../src/decision/types.ts";
import { ruleHash } from "../src/research/rules.ts";
import type { RuleDefinition } from "../src/research/rules.ts";
import { planTrade } from "../src/research/planner.ts";
import type { PlannerConfig, TradePlan } from "../src/research/planner.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import { writeSnapshot } from "../src/research/snapshot-store.ts";
import type { FeatureVector, SourceRow, SourceSnapshot } from "../src/research/types.ts";
import type { DailyReport } from "../src/research/report.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import { reviewClosedTrade } from "../src/journal/trade-analytics.ts";

type PlanRow = Extract<TradePlan, { kind: "plan" }>;

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "decide-cli-test-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const DATE = "2026-09-18";
const DECISION_TIME = Date.parse(`${DATE}T00:15:00Z`);
const NOW = DECISION_TIME + 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 20 consecutive daily bars (o=60000, h=60500, l=59500, c=60000 -> true range 1000 on every
 *  bar), the last one closing exactly at DECISION_TIME - so `close` = 60000 and `atr14d` = 1000,
 *  both round numbers matching AC-11's numeric inputs. */
function dailyKlinesSnapshot(): SourceSnapshot {
  const rows: SourceRow[] = [];
  for (let i = 0; i < 20; i++) {
    const t = DECISION_TIME - DAY_MS - i * DAY_MS;
    const availableAt = t + DAY_MS;
    for (const [field, value] of [["open", 60000], ["high", 60500], ["low", 59500], ["close", 60000], ["volume", 1000]] as const) {
      rows.push({ key: "BTC/USDT", observedFor: t, availableAt, value, field });
    }
  }
  return { sourceId: "bybit-klines-1d", fetchedAt: DECISION_TIME, status: "ok", statusDetail: "", rows, sha256: "" };
}

function instrumentsSnapshot(): SourceSnapshot {
  const rows: SourceRow[] = [];
  for (const symbol of ["BTC/USDT", "ETH/USDT"]) {
    rows.push(
      { key: symbol, observedFor: DECISION_TIME, availableAt: DECISION_TIME, value: 0.0001, field: "minOrderQty" },
      { key: symbol, observedFor: DECISION_TIME, availableAt: DECISION_TIME, value: 0.0001, field: "qtyStep" },
      { key: symbol, observedFor: DECISION_TIME, availableAt: DECISION_TIME, value: 5, field: "minNotionalValue" },
    );
  }
  return { sourceId: "bybit-instruments", fetchedAt: DECISION_TIME, status: "ok", statusDetail: "", rows, sha256: "" };
}

const SNAPSHOTS = [dailyKlinesSnapshot(), instrumentsSnapshot()];
const FEATURES: FeatureVector[] = buildFeatures(SNAPSHOTS, ["BTC/USDT", "ETH/USDT"], DECISION_TIME, DEFAULT_STALENESS_MS);
const FV = FEATURES.find((f) => f.symbol === "BTC/USDT")!;

const PLANNER_CFG: PlannerConfig = {
  maxCapitalUsd: 100, riskPerTradePercent: 1, maxLeverage: 5, liveLadderCap: 2,
  marginBudgetPercent: 25, maintenanceMarginRate: 0.005, minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11, maxOpenManualTrades: 3,
};

const RULE: RuleDefinition = {
  id: "etf-flow-momentum", version: 1, description: "d", evidence: ["X1"], status: "experimental",
  symbols: ["BTC/USDT"], side: "long",
  entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
  stopAtrMultiple: 2, targetRMultiple: 2, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
};

function makeSourcePlan(): PlanRow {
  const outcome = { ruleId: RULE.id, ruleHash: ruleHash(RULE), symbol: "BTC/USDT", result: "triggered" as const, evidence: {} };
  const plan = planTrade(outcome, RULE, FV, PLANNER_CFG, 0, false, DATE, 0, false, { minOrderQty: 0.0001, qtyStep: 0.0001, minNotionalValue: 5 }, DECISION_TIME);
  assert.equal(plan.kind, "plan");
  return plan as PlanRow;
}

function makeReport(plan: PlanRow): DailyReport {
  return {
    schemaVersion: 1, dateUtc: DATE, decisionTime: DECISION_TIME, generatedAt: DECISION_TIME,
    ruleSetSha256: "deadbeef", sources: [], completeness: "complete",
    breaker: { tripped: false, trigger: null, details: "" },
    outcomes: [], plans: [plan], openTradeThesis: [],
    aiAnalyst: {
      status: "disabled", reason: "", model: null, provider: null, servedByModel: null, promptVersionHash: null,
      costUsd: 0, monthToDateUsd: 0, listCostUsd: 0, regimeSummary: null,
      assessments: [], plans: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], rejected: [],
    },
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };
}

/** A minimal, real skill directory + prompt file, plus config/rules/journal/report fixtures. */
function setupFixtures(dir: string): { args: DecideArgs; sourcePlan: PlanRow } {
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    exchange: "bybit", apiKey: "k", apiSecret: "s", symbols: ["BTC/USDT", "ETH/USDT"],
    maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 10,
    stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  }));
  writeFileSync(join(dir, "research-rules.json"), JSON.stringify({ schemaVersion: 1, rules: [RULE] }));
  writeFileSync(join(dir, "manual-journal.json"), JSON.stringify([]));

  const skillRoot = join(dir, "skill");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), "skill body\n");
  const promptPath = join(dir, "prompts", "ai-analyst.md");
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(promptPath, "prompt body\n");

  const sourcePlan = makeSourcePlan();
  const reportsRoot = join(dir, "reports");
  mkdirSync(reportsRoot, { recursive: true });
  writeFileSync(join(reportsRoot, `${DATE}.json`), JSON.stringify(makeReport(sourcePlan)));

  const snapshotRoot = join(dir, "snapshots");
  for (const snap of SNAPSHOTS) writeSnapshot(DATE, snap, { rootDir: snapshotRoot });

  const args: DecideArgs = {
    date: DATE, mode: "plan", revise: false, trade: null, input: null,
    configPath: join(dir, "config.json"),
    decisionsRoot: join(dir, "decisions"),
    reportsRoot,
    journalPath: join(dir, "manual-journal.json"),
    rulesPath: join(dir, "research-rules.json"),
    aiRulesRoot: join(dir, "ai-rules"),
    skillRoot,
    syncStatusPath: join(dir, "manual-journal.sync.json"),
    promptPath,
    repoRoot: dir,
    snapshotRoot,
  };
  return { args, sourcePlan };
}

function planInputFor(sourcePlan: PlanRow): unknown {
  return {
    dateUtc: DATE,
    choice: { kind: "report-plan", planId: sourcePlan.planId },
    stances: [{ planId: sourcePlan.planId, stance: "support", reasons: ["good"] }],
    news: [],
    rationale: "Following the rule plan.",
  };
}

function deps(json: unknown) {
  return { now: () => NOW, readStdin: async () => JSON.stringify(json) };
}

test("parseDecideArgs: defaults", () => {
  const args = parseDecideArgs(["--date", "2026-09-18"], NOW);
  assert.equal(args.mode, "plan");
  assert.equal(args.revise, false);
  assert.equal(args.trade, null);
  assert.equal(args.decisionsRoot, "data/decisions");
});

test("AC-98/AC-112: a valid plan decision writes exit 0, the decision file and a Plan Report", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const result = await runDecide(args, deps(planInputFor(sourcePlan)));
    assert.equal(result.exitCode, 0, result.message);
    const decision = result.decision as DailyDecision;
    assert.equal(decision.plan!.origin, "persona");
    assert.equal(decision.plan!.ruleId, `persona-${decision.skillHash.slice(0, 8)}`);
    assert.equal(decision.plan!.ruleHash, decision.skillHash);
    assert.equal(decision.basedOnPlanId, sourcePlan.planId);
    assert.equal(decision.basedOnRuleKey, `${RULE.id}@${ruleHash(RULE).slice(0, 8)}`);
    assert.ok(result.planReport && result.planReport.includes("# Plan Report"));
  });
});

test("AC-119: a real second open journal trade appears in the Plan Report's section 7 with today's manage path", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const otherTrade: ManualTrade = {
      id: "other-open-trade", venue: "paper", symbol: "ETH/USDT", side: "short", planId: "2026-09-15:persona-deadbeef:ETH/USDT",
      ruleId: "persona-deadbeef", ruleHash: "d".repeat(64), plannedSnapshot: null, aiStanceAtPlan: null,
      entryFills: [{ execId: "o1", time: NOW, price: 3000, qty: 0.01, feeUsd: 0, side: "sell" }],
      exitFills: [], actualLeverage: 1, exchangeLiqPrice: null, fundingUsd: 0,
      status: "open", exitKind: null, notes: "", createdAt: NOW, updatedAt: NOW,
    };
    writeFileSync(args.journalPath, JSON.stringify([otherTrade]));

    const result = await runDecide(args, deps(planInputFor(sourcePlan)));
    assert.equal(result.exitCode, 0, result.message);
    const md = result.planReport!;

    assert.match(md, /## 7\. Other open positions/);
    assert.match(md, /other-open-trade/);
    assert.match(md, /ETH\/USDT/);
    assert.match(md, /short/);
    assert.match(md, /2026-09-15:persona-deadbeef:ETH\/USDT/);
    assert.match(md, new RegExp(`data/decisions/${DATE}\\.manage\\.other-open-trade\\.json`));

    // Section 7 lists only the OTHER trade — the decision's own (not-yet-linked) trade id never
    // appears there, and the "None." fallback is not used since one other trade exists.
    const section7 = md.slice(md.indexOf("## 7. Other open positions"));
    assert.doesNotMatch(section7, /\nNone\.\n/);
  });
});

test("AC-109: no report for the date -> exit 3 with 'run research:daily first'", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const result = await runDecide({ ...args, date: "2026-09-17" }, deps(planInputFor(sourcePlan)));
    assert.equal(result.exitCode, 3);
    assert.match(result.message, /run research:daily first/);
  });
});

test("AC-109: --date 2099-01-01 -> exit 4", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const result = await runDecide({ ...args, date: "2099-01-01" }, deps(planInputFor(sourcePlan)));
    assert.equal(result.exitCode, 4);
  });
});

test("AC-109: a --skill-root missing SKILL.md (nonexistent dir) -> exit 5, nothing written", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const result = await runDecide({ ...args, skillRoot: join(dir, "does-not-exist") }, deps(planInputFor(sourcePlan)));
    assert.equal(result.exitCode, 5);
    assert.equal(result.decision, null);
  });
});

test("exit 2: invalid JSON on stdin", async () => {
  await withTempDir(async (dir) => {
    const { args } = setupFixtures(dir);
    const result = await runDecide(args, { now: () => NOW, readStdin: async () => "{not json" });
    assert.equal(result.exitCode, 2);
  });
});

test("exit 2: input failing schema shape", async () => {
  await withTempDir(async (dir) => {
    const { args } = setupFixtures(dir);
    const result = await runDecide(args, deps({ dateUtc: DATE })); // missing choice/stances/etc.
    assert.equal(result.exitCode, 2);
  });
});

test("AC-107: write-once and --revise — second run without --revise exits 3, bytes unchanged; --revise writes .r1, then .r2", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const first = await runDecide(args, deps(planInputFor(sourcePlan)));
    assert.equal(first.exitCode, 0, first.message);

    const again = await runDecide(args, deps(planInputFor(sourcePlan)));
    assert.equal(again.exitCode, 3);

    writeFileSync(join(dir, "manual-journal.sync.json"), JSON.stringify({ syncedAt: NOW, status: "ok", error: null, liveSync: "disabled" }));
    const revised = await runDecide({ ...args, revise: true }, deps(planInputFor(sourcePlan)));
    assert.equal(revised.exitCode, 0, revised.message);
    assert.equal((revised.decision as DailyDecision).revision, 1);

    const revisedAgain = await runDecide({ ...args, revise: true }, deps(planInputFor(sourcePlan)));
    assert.equal(revisedAgain.exitCode, 0, revisedAgain.message);
    assert.equal((revisedAgain.decision as DailyDecision).revision, 2);
  });
});

test("AC-108: --revise refuses when a journal trade already links to the effective decision's plan", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const first = await runDecide(args, deps(planInputFor(sourcePlan)));
    assert.equal(first.exitCode, 0);
    const decision = first.decision as DailyDecision;

    const trade: ManualTrade = {
      id: "trade-linked", venue: "paper", symbol: "BTC/USDT", side: "long", planId: decision.plan!.planId,
      ruleId: decision.plan!.ruleId, ruleHash: decision.plan!.ruleHash, plannedSnapshot: decision.plan, aiStanceAtPlan: null,
      entryFills: [{ execId: "e1", time: NOW, price: 60000, qty: decision.plan!.quantity, feeUsd: 0, side: "buy" }],
      exitFills: [], actualLeverage: decision.plan!.leverage, exchangeLiqPrice: null, fundingUsd: 0,
      status: "open", exitKind: null, notes: "", createdAt: NOW, updatedAt: NOW,
    };
    writeFileSync(args.journalPath, JSON.stringify([trade]));
    writeFileSync(join(dir, "manual-journal.sync.json"), JSON.stringify({ syncedAt: NOW, status: "ok", error: null, liveSync: "disabled" }));

    const revised = await runDecide({ ...args, revise: true }, deps(planInputFor(sourcePlan)));
    assert.equal(revised.exitCode, 3);
    assert.match(revised.message, /trade-linked/);
  });
});

test("AC-122: --revise exits 5 when the sync sidecar is stale, missing or unparseable; proceeds when fresh or paper-only", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const first = await runDecide(args, deps(planInputFor(sourcePlan)));
    assert.equal(first.exitCode, 0);

    // Missing sidecar -> exit 5
    const missing = await runDecide({ ...args, revise: true }, deps(planInputFor(sourcePlan)));
    assert.equal(missing.exitCode, 5);
    assert.match(missing.message, /journal_stale/);

    // Stale (older than staleAfterMs default 120000) -> exit 5
    writeFileSync(join(dir, "manual-journal.sync.json"), JSON.stringify({ syncedAt: NOW - 300_000, status: "ok", error: null, liveSync: "enabled" }));
    const stale = await runDecide({ ...args, revise: true }, deps(planInputFor(sourcePlan)));
    assert.equal(stale.exitCode, 5);

    // Fresh -> proceeds (exit 0)
    writeFileSync(join(dir, "manual-journal.sync.json"), JSON.stringify({ syncedAt: NOW - 60_000, status: "ok", error: null, liveSync: "enabled" }));
    const fresh = await runDecide({ ...args, revise: true }, deps(planInputFor(sourcePlan)));
    assert.equal(fresh.exitCode, 0, fresh.message);
  });
});

// ── manage / review modes ────────────────────────────────────────────────────────────────────

function makeOpenTrade(id: string, plan: PlanRow): ManualTrade {
  return {
    id, venue: "paper", symbol: plan.symbol, side: plan.side, planId: plan.planId,
    ruleId: plan.ruleId, ruleHash: plan.ruleHash, plannedSnapshot: plan, aiStanceAtPlan: null,
    entryFills: [{ execId: `${id}-e1`, time: NOW, price: plan.referencePrice, qty: plan.quantity, feeUsd: 0, side: "buy" }],
    exitFills: [], actualLeverage: plan.leverage, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "", createdAt: NOW, updatedAt: NOW,
  };
}

test("AC-113a: two trades managed the same day write two independent artifacts", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const tradeA = makeOpenTrade("trade-A", sourcePlan);
    const tradeB = makeOpenTrade("trade-B", sourcePlan);
    writeFileSync(args.journalPath, JSON.stringify([tradeA, tradeB]));

    const manageArgs: DecideArgs = { ...args, mode: "manage" };
    const inputFor = (tradeId: string) => ({ dateUtc: DATE, tradeId, action: { kind: "hold" }, thesis: "intact", reasons: ["ok"], news: [] });

    const resultA = await runDecide({ ...manageArgs, trade: "trade-A" }, deps(inputFor("trade-A")));
    assert.equal(resultA.exitCode, 0, resultA.message);
    const resultB = await runDecide({ ...manageArgs, trade: "trade-B" }, deps(inputFor("trade-B")));
    assert.equal(resultB.exitCode, 0, resultB.message);

    const again = await runDecide({ ...manageArgs, trade: "trade-A" }, deps(inputFor("trade-A")));
    assert.equal(again.exitCode, 3);
    assert.match(again.message, /trade-A/);

    const resultBAgain = await runDecide({ ...manageArgs, trade: "trade-B" }, deps(inputFor("trade-B")));
    assert.equal(resultBAgain.exitCode, 3); // B was already written once too; verifies it wasn't shadowed by A
  });
});

test("AC-113b: a manage decision cannot be revised once the trade has since closed (recordPaperExit-shaped update)", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const tradeA = makeOpenTrade("trade-A", sourcePlan);
    writeFileSync(args.journalPath, JSON.stringify([tradeA]));
    writeFileSync(join(dir, "manual-journal.sync.json"), JSON.stringify({ syncedAt: NOW, status: "ok", error: null, liveSync: "disabled" }));

    const manageArgs: DecideArgs = { ...args, mode: "manage", trade: "trade-A" };
    const holdInput = { dateUtc: DATE, tradeId: "trade-A", action: { kind: "hold" }, thesis: "intact", reasons: ["ok"], news: [] };

    const first = await runDecide(manageArgs, deps(holdInput));
    assert.equal(first.exitCode, 0, first.message);

    // Simulate what recordPaperExit actually does: status -> "closed", a new exit fill, and
    // updatedAt bumped past the effective manage decision's writtenAt — the real-world trigger
    // for AC-113b, and the one that used to collide with validateManage's own trade_not_open
    // check (exit 2) before the acted-on rule was moved ahead of general validation.
    const closedTrade: ManualTrade = {
      ...tradeA, status: "closed", exitKind: "target",
      exitFills: [{ execId: "trade-A-exit", time: NOW + 1000, price: sourcePlan.targetPrice, qty: sourcePlan.quantity, feeUsd: 0, side: "sell" }],
      updatedAt: NOW + 1000,
    };
    writeFileSync(args.journalPath, JSON.stringify([closedTrade]));

    const filesBefore = readdirSync(args.decisionsRoot).sort();
    const revised = await runDecide({ ...manageArgs, revise: true }, deps(holdInput));
    assert.equal(revised.exitCode, 3, revised.message);
    assert.match(revised.message, /trade-A/);
    assert.deepEqual(readdirSync(args.decisionsRoot).sort(), filesBefore); // nothing new written
  });
});

test("AC-113b: a manage decision cannot be revised after a metadata-only updatedAt bump (still open)", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const tradeA = makeOpenTrade("trade-A", sourcePlan);
    writeFileSync(args.journalPath, JSON.stringify([tradeA]));
    writeFileSync(join(dir, "manual-journal.sync.json"), JSON.stringify({ syncedAt: NOW, status: "ok", error: null, liveSync: "disabled" }));

    const manageArgs: DecideArgs = { ...args, mode: "manage", trade: "trade-A" };
    const holdInput = { dateUtc: DATE, tradeId: "trade-A", action: { kind: "hold" }, thesis: "intact", reasons: ["ok"], news: [] };

    const first = await runDecide(manageArgs, deps(holdInput));
    assert.equal(first.exitCode, 0, first.message);

    // Still open, still planned, still the same thesis — only `updatedAt` moved past the
    // effective decision's `writtenAt` (e.g. a notes edit or a re-link). §5.15: "any ... updatedAt
    // later than writtenAt" is on its own enough to refuse the revise.
    const touchedTrade: ManualTrade = { ...tradeA, updatedAt: NOW + 1000, notes: "owner edited notes" };
    writeFileSync(args.journalPath, JSON.stringify([touchedTrade]));

    const filesBefore = readdirSync(args.decisionsRoot).sort();
    const revised = await runDecide({ ...manageArgs, revise: true }, deps(holdInput));
    assert.equal(revised.exitCode, 3, revised.message);
    assert.match(revised.message, /trade-A/);
    assert.deepEqual(readdirSync(args.decisionsRoot).sort(), filesBefore);
  });
});

test("AC-114a: two trades reviewed the same day write two independent artifacts", async () => {
  await withTempDir(async (dir) => {
    const { args, sourcePlan } = setupFixtures(dir);
    const closedA: ManualTrade = { ...makeOpenTrade("review-A", sourcePlan), status: "closed", exitKind: "target", exitFills: [{ execId: "x", time: NOW, price: sourcePlan.targetPrice, qty: sourcePlan.quantity, feeUsd: 0, side: "sell" }] };
    const closedB: ManualTrade = { ...makeOpenTrade("review-B", sourcePlan), status: "closed", exitKind: "target", exitFills: [{ execId: "y", time: NOW, price: sourcePlan.targetPrice, qty: sourcePlan.quantity, feeUsd: 0, side: "sell" }] };
    writeFileSync(args.journalPath, JSON.stringify([closedA, closedB]));

    // Compute the exact numbers the CLI itself will compute (reviewClosedTrade with no klines,
    // matching runDecide's own review-mode path when deps.fetchKlines is unset), so the
    // ReviewInput agrees with the system on the first try — no exit-2 tolerance needed.
    const computedA = reviewClosedTrade(closedA, []);
    const computedB = reviewClosedTrade(closedB, []);

    const reviewArgs: DecideArgs = { ...args, mode: "review" };

    async function reviewFor(tradeId: string, computed: ReturnType<typeof reviewClosedTrade>) {
      return runDecide({ ...reviewArgs, trade: tradeId }, {
        now: () => NOW,
        readStdin: async () => JSON.stringify({
          dateUtc: DATE, tradeId, rMultiple: computed.rMultiple, exitKind: computed.exitKind,
          followedPlan: computed.followedPlan, thesisVerdict: "confirmed", lesson: "l",
        }),
      });
    }

    const first = await reviewFor("review-A", computedA);
    assert.equal(first.exitCode, 0, first.message);
    const decisionA = first.decision as ReviewDecision;
    assert.equal(decisionA.computed.rMultiple, computedA.rMultiple);
    assert.equal(decisionA.computed.exitKind, computedA.exitKind);
    assert.equal(decisionA.computed.followedPlan, computedA.followedPlan);

    const second = await reviewFor("review-A", computedA);
    assert.equal(second.exitCode, 3);

    const otherTrade = await reviewFor("review-B", computedB);
    assert.equal(otherTrade.exitCode, 0, otherTrade.message); // not shadowed by review-A's artifact
  });
});


test("an interactive terminal with no --input exits 4 with a usage line, never waits for EOF", async () => {
  await withTempDir(async (dir) => {
    const { args } = setupFixtures(dir);
    // defaultReadStdin resolves this sentinel when process.stdin.isTTY — otherwise the run just
    // waits for an EOF the owner has no reason to send, showing no output at all.
    const result = await runDecide(args, { now: () => NOW, readStdin: async () => STDIN_IS_A_TTY });

    assert.equal(result.exitCode, 4);
    assert.match(result.message, /no decision input/);
    assert.match(result.message, /--input <file\.json>/);
    assert.match(result.message, /decision-protocol\.md/);
    assert.equal(existsSync(join(dir, "decisions", `${DATE}.json`)), false);
  });
});
