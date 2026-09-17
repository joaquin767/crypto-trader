// decide CLI — specs/daily-catalyst-manual-trading.md §4.22, §5.12, §5.15 (revision 3, Phase 6).
//
// The ONLY writer of `data/decisions/` and `reports/*.decision.md` (P9, verification gate
// §12.15). Reads stdin/--input, loads the report/journal/rules/config, calls the pure
// src/decision/decide.ts + plan-report.ts functions, enforces write-once/--revise, and sets exit
// codes. Mirrors scripts/research-daily.ts's shape: an injectable-deps `runDecide` the tests call
// directly, plus a thin `main()` for real CLI use.
//
// Usage: node --experimental-strip-types scripts/decide-daily.ts --config ./config.json
//   --date YYYY-MM-DD --mode plan|manage|review [--trade <id>] [--input <file>] [--revise]
//   [--decisions-root DIR] [--reports-root DIR] [--journal-path FILE] [--rules-path FILE]
//   [--ai-rules-root DIR] [--skill-root DIR] [--sync-status-path FILE] [--snapshot-root DIR]
//   [--prompt-path FILE] [--repo-root DIR]
//
// Exit codes (§5.15): 0 written; 2 validation failed (every rejection printed); 3 precondition
// (no report for the date; artifact of that identity exists without --revise; or --revise
// refused because the owner already acted on it); 4 bad --date; 5 journal/rules/skill unreadable,
// or a stale journal blocking --revise.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, resolveManualTradingConfig, resolvePersonaConfig } from "../src/config.ts";
import type { ManualTradingConfig, PersonaConfig } from "../src/config.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import { readSnapshots } from "../src/research/snapshot-store.ts";
import type { RuleDefinition, RuleSet } from "../src/research/rules.ts";
import { evaluateThesis, parseRuleSet, RuleSetValidationError } from "../src/research/rules.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "../src/research/planner.ts";
import { instrumentFilters } from "../src/research/planner.ts";
import type { DailyReport } from "../src/research/report.ts";
import type { FeatureVector } from "../src/research/types.ts";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "../src/risk/circuit-breaker.ts";
import { computeBreaker } from "../src/journal/breaker.ts";
import {
  JournalUnreadableError, loadManualJournal, readSyncStatus,
} from "../src/journal/manual-journal.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import { reviewClosedTrade } from "../src/journal/trade-analytics.ts";
import { dateFromPlanId, loadEffectiveDecision } from "../src/decision/decisions-store.ts";
import {
  buildOwnerProtocol, parseDailyDecisionInput, parseManageInput, parseReviewInput, planFromChoice,
  validateDecision, validateManage, validateReview, withPersonaProvenance,
} from "../src/decision/decide.ts";
import { skillHash, SkillHashError } from "../src/decision/skill-hash.ts";
import { renderPlanReport } from "../src/decision/plan-report.ts";
import type { OtherOpenTradeRow } from "../src/decision/plan-report.ts";
import type {
  DailyDecision, DecideArgs, DecideDeps, DecisionContext, ManageContext, ManageDecision,
  ManageInput, ReviewContext, ReviewDecision, ReviewInput,
} from "../src/decision/types.ts";

type PlanRow = Extract<TradePlan, { kind: "plan" }>;

// §5.8a "research:daily wiring" / gate-d1's own copy: until the trip log exists, the leverage
// ladder cap stays fail-closed at `liveLadderCap`. Duplicated here for the same normative reason
// documented in scripts/research-daily.ts's own copy.
const LADDER_RESET_BY_BREAKER = true;

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function parseDecideArgs(argv: readonly string[], now: number): DecideArgs {
  const configPath = flagValue(argv, "--config") ?? "./config.json";
  const journalPath = flagValue(argv, "--journal-path") ?? "./manual-journal.json";
  const modeArg = flagValue(argv, "--mode") ?? "plan";
  return {
    date: flagValue(argv, "--date") ?? todayUtc(now),
    mode: modeArg === "manage" || modeArg === "review" ? modeArg : "plan",
    revise: argv.includes("--revise"),
    trade: flagValue(argv, "--trade") ?? null,
    input: flagValue(argv, "--input") ?? null,
    configPath,
    decisionsRoot: flagValue(argv, "--decisions-root") ?? "data/decisions",
    reportsRoot: flagValue(argv, "--reports-root") ?? "reports",
    journalPath,
    rulesPath: flagValue(argv, "--rules-path") ?? "./research-rules.json",
    aiRulesRoot: flagValue(argv, "--ai-rules-root") ?? "data/ai-rules",
    skillRoot: flagValue(argv, "--skill-root") ?? ".claude/skills/crypto-fundamental-analyst",
    syncStatusPath: flagValue(argv, "--sync-status-path") ?? `${journalPath.replace(/\.json$/, "")}.sync.json`,
    promptPath: flagValue(argv, "--prompt-path") ?? "prompts/ai-analyst.md",
    repoRoot: flagValue(argv, "--repo-root") ?? process.cwd(),
    snapshotRoot: flagValue(argv, "--snapshot-root") ?? "data/snapshots",
  };
}

export function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ── Small shared helpers ─────────────────────────────────────────────────────────────────────

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highest existing revision for `<root>/<baseName>(.rN).json`, or -1 if none exists. */
function latestRevision(root: string, baseName: string): number {
  if (!existsSync(root)) return -1;
  const re = new RegExp(`^${escapeForRegExp(baseName)}(?:\\.r(\\d+))?\\.json$`);
  let latest = -1;
  for (const file of readdirSync(root)) {
    const m = re.exec(file);
    if (!m) continue;
    const rev = m[1] ? Number.parseInt(m[1], 10) : 0;
    if (rev > latest) latest = rev;
  }
  return latest;
}

function artifactPath(root: string, baseName: string, revision: number): string {
  return join(root, revision > 0 ? `${baseName}.r${revision}.json` : `${baseName}.json`);
}

function writeOnce(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { flag: "wx" });
}

/** Highest-revision `reports/<date>(.rN).json`, its raw bytes and sha256; null if none exists. */
function findEffectiveReport(reportsRoot: string, date: string): { path: string; raw: string; sha256: string; report: DailyReport } | null {
  if (!existsSync(reportsRoot)) return null;
  const re = new RegExp(`^${escapeForRegExp(date)}(?:\\.r(\\d+))?\\.json$`);
  let best: { revision: number; file: string } | null = null;
  for (const file of readdirSync(reportsRoot)) {
    const m = re.exec(file);
    if (!m) continue;
    const revision = m[1] ? Number.parseInt(m[1], 10) : 0;
    if (!best || revision > best.revision) best = { revision, file };
  }
  if (!best) return null;
  const path = join(reportsRoot, best.file);
  const raw = readFileSync(path, "utf-8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  return { path, raw, sha256, report: JSON.parse(raw) as DailyReport };
}

/** Resolves the RuleDefinition for one ManualTrade, exactly the way §5.8a resolves a planId:
 *  research-rules.json for a rule-origin trade, data/ai-rules/<planId>.json for AI-origin, the
 *  decision file's personaRule for persona-origin. Never throws — an unavailable rule simply
 *  yields no result, and the caller falls back to `not_evaluable`. */
function resolveTradeRule(trade: ManualTrade, ruleSet: RuleSet, args: DecideArgs): RuleDefinition | null {
  if (trade.ruleId === null) return null;
  const fileRule = ruleSet.rules.find((r) => r.id === trade.ruleId);
  if (fileRule) return fileRule;
  if (trade.planId === null) return null;
  if (trade.ruleId.startsWith("persona-")) {
    const date = dateFromPlanId(trade.planId);
    if (date === null) return null;
    const decision = loadEffectiveDecision(args.decisionsRoot, date);
    return decision?.personaRule ?? null;
  }
  try {
    return JSON.parse(readFileSync(join(args.aiRulesRoot, `${trade.planId}.json`), "utf-8")) as RuleDefinition;
  } catch {
    return null;
  }
}

function checkSyncFreshness(args: DecideArgs, manual: ManualTradingConfig, now: number): string | null {
  let status;
  try {
    status = readSyncStatus({ path: args.syncStatusPath });
  } catch {
    return "journal_stale: run the journal server sync first";
  }
  if (status === null) return "journal_stale: run the journal server sync first";
  if (status.liveSync === "disabled") return null; // paper-only mode: nothing to be stale about
  if (status.status !== "ok") return "journal_stale: run the journal server sync first";
  if (now - status.syncedAt > manual.staleAfterMs) return "journal_stale: run the journal server sync first";
  return null;
}

type RunResult = { exitCode: number; message: string; decision: DailyDecision | ManageDecision | ReviewDecision | null; planReport: string | null };

function rejectionLines(rejections: readonly { code: string; path: string; detail: string }[]): string {
  return rejections.map((r) => `${r.code} ${r.path}: ${r.detail}`).join("\n");
}

// ── runDecide ────────────────────────────────────────────────────────────────────────────────

export async function runDecide(args: DecideArgs, deps: DecideDeps): Promise<RunResult> {
  const now = deps.now();
  const noResult = (): { decision: null; planReport: null } => ({ decision: null, planReport: null });

  const scheduledDecisionTime = Date.parse(`${args.date}T00:15:00Z`);
  if (!Number.isFinite(scheduledDecisionTime)) {
    return { exitCode: 4, message: `invalid --date "${args.date}"`, ...noResult() };
  }
  if (scheduledDecisionTime > now) {
    return { exitCode: 4, message: `decision time ${new Date(scheduledDecisionTime).toISOString()} is in the future`, ...noResult() };
  }

  if (args.mode === "plan" && args.trade !== null) {
    return { exitCode: 2, message: "schema_invalid --trade: not accepted for --mode plan", ...noResult() };
  }
  if ((args.mode === "manage" || args.mode === "review") && args.trade === null) {
    return { exitCode: 2, message: `schema_invalid --trade: required for --mode ${args.mode}`, ...noResult() };
  }

  const reportInfo = findEffectiveReport(args.reportsRoot, args.date);
  if (!reportInfo) {
    return { exitCode: 3, message: `no report for ${args.date}; run research:daily first`, ...noResult() };
  }

  let config;
  try {
    config = loadConfig(args.configPath);
  } catch (err) {
    return { exitCode: 5, message: `config unreadable/invalid: ${(err as Error).message}`, ...noResult() };
  }
  const personaCfg: PersonaConfig = resolvePersonaConfig(config);
  const manual: ManualTradingConfig = resolveManualTradingConfig(config);

  let journal: ManualTrade[];
  try {
    journal = loadManualJournal({ path: args.journalPath });
  } catch (err) {
    if (err instanceof JournalUnreadableError) return { exitCode: 5, message: err.message, ...noResult() };
    throw err;
  }

  let ruleSet: RuleSet;
  try {
    const raw = readFileSync(args.rulesPath, "utf-8");
    ruleSet = parseRuleSet(JSON.parse(raw), config.symbols);
  } catch (err) {
    if (err instanceof RuleSetValidationError) {
      return { exitCode: 5, message: `research-rules.json invalid: ${err.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, ...noResult() };
    }
    return { exitCode: 5, message: `research-rules.json unreadable: ${(err as Error).message}`, ...noResult() };
  }

  let hash: string;
  try {
    hash = skillHash({ skillRoot: args.skillRoot, promptPath: args.promptPath, repoRoot: args.repoRoot });
  } catch (err) {
    if (err instanceof SkillHashError) return { exitCode: 5, message: err.message, ...noResult() };
    throw err;
  }

  const rawInputText = args.input !== null ? readFileSync(args.input, "utf-8") : await deps.readStdin();
  let rawInput: unknown;
  try {
    rawInput = JSON.parse(rawInputText);
  } catch (err) {
    return { exitCode: 2, message: `schema_invalid input: not valid JSON (${(err as Error).message})`, ...noResult() };
  }

  const snapshots = readSnapshots(args.date, { rootDir: args.snapshotRoot });
  const features: FeatureVector[] = buildFeatures(snapshots, config.symbols, reportInfo.report.decisionTime, DEFAULT_STALENESS_MS);
  const instruments: Record<string, InstrumentFilter | null> = instrumentFilters(snapshots, config.symbols);

  const plannerConfig: PlannerConfig = {
    maxCapitalUsd: config.maxCapitalUsd,
    riskPerTradePercent: config.riskPerTradePercent ?? 1,
    maxLeverage: manual.maxLeverage,
    liveLadderCap: manual.liveLadderCap,
    marginBudgetPercent: manual.marginBudgetPercent,
    maintenanceMarginRate: manual.maintenanceMarginRate,
    minLiqToStopRatio: manual.minLiqToStopRatio,
    roundTripFeePercent: manual.roundTripFeePercent,
    maxOpenManualTrades: manual.maxOpenManualTrades,
  };

  const breaker = computeBreaker(
    journal,
    {
      maxDailyLossPercent: config.maxDailyLossPercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDailyLossPercent,
      maxDrawdownHaltPercent: config.maxDrawdownHaltPercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDrawdownHaltPercent,
      maxConsecutiveLosses: config.maxConsecutiveLosses ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxConsecutiveLosses,
      maxSlippagePercent: config.maxSlippagePercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxSlippagePercent,
      breakerResetAt: manual.breakerResetAt === null ? null : Date.parse(manual.breakerResetAt),
    },
    config.maxCapitalUsd,
    now,
  );

  const personaRuleId = `persona-${hash.slice(0, 8)}`;
  const liveClosedTradesForPersona = journal.filter(
    (t) => t.venue === "bybit-live" && t.status === "closed" && t.ruleId === personaRuleId,
  ).length;

  if (args.mode === "plan") {
    return runPlanMode(args, rawInput, now, reportInfo, {
      config, personaCfg, manual, journal, ruleSet, hash, features, instruments, plannerConfig, breaker,
      liveClosedTradesForPersona,
    });
  }
  if (args.mode === "manage") {
    return runManageMode(args, rawInput, now, reportInfo, { manual, journal, ruleSet, hash, features, personaCfg });
  }
  return runReviewMode(args, rawInput, now, { manual, journal, hash, personaCfg }, deps);
}

interface PlanModeCtx {
  config: ReturnType<typeof loadConfig>;
  personaCfg: PersonaConfig;
  manual: ManualTradingConfig;
  journal: ManualTrade[];
  ruleSet: RuleSet;
  hash: string;
  features: FeatureVector[];
  instruments: Record<string, InstrumentFilter | null>;
  plannerConfig: PlannerConfig;
  breaker: { tripped: boolean; trigger: string | null; details: string };
  liveClosedTradesForPersona: number;
}

async function runPlanMode(
  args: DecideArgs, rawInput: unknown, now: number,
  reportInfo: { path: string; raw: string; sha256: string; report: DailyReport },
  pctx: PlanModeCtx,
): Promise<RunResult> {
  const input = parseDailyDecisionInput(rawInput);
  if (input === null) {
    return { exitCode: 2, message: "schema_invalid input: does not match DailyDecisionInput", decision: null, planReport: null };
  }

  // aiRules for validateDecision's findSourceRule, keyed by planId (see decide.ts's header note):
  // only the one plan the persona actually chose (when it's an ai-analyst-origin one) is loaded.
  const aiRules: Record<string, RuleDefinition> = {};
  for (const p of reportInfo.report.plans) {
    if (p.kind === "plan" && p.origin === "ai-analyst" && input.choice.kind === "report-plan" && p.planId === input.choice.planId) {
      try {
        aiRules[p.planId] = JSON.parse(readFileSync(join(args.aiRulesRoot, `${p.planId}.json`), "utf-8")) as RuleDefinition;
      } catch {
        // left absent -> findSourceRule returns null -> rule_changed rejection
      }
    }
  }

  const ctx: DecisionContext = {
    dateUtc: args.date,
    report: reportInfo.report,
    reportPath: reportInfo.path,
    reportSha256: reportInfo.sha256,
    features: pctx.features,
    configSymbols: pctx.config.symbols,
    plannerConfig: pctx.plannerConfig,
    personaCfg: pctx.personaCfg,
    skillHash: pctx.hash,
    ruleSet: pctx.ruleSet,
    aiRules,
    journal: pctx.journal,
    breaker: pctx.breaker,
    liveClosedTradesForPersona: pctx.liveClosedTradesForPersona,
    ladderResetByBreaker: LADDER_RESET_BY_BREAKER,
    instruments: pctx.instruments,
    now,
  };

  const validation = validateDecision(input, ctx);
  if (!validation.ok) {
    return { exitCode: 2, message: rejectionLines(validation.rejections), decision: null, planReport: null };
  }

  let plan: PlanRow | null = null;
  let personaRule: RuleDefinition | null = null;
  let basedOnPlanId: string | null = null;
  let basedOnRuleKey: string | null = null;

  if (input.choice.kind !== "no-trade") {
    const attempt = planFromChoice(input.choice, ctx);
    if (!attempt || attempt.plan.kind !== "plan") {
      // validateDecision already guarantees this doesn't happen when ok===true, but fail closed.
      return { exitCode: 2, message: "replan_rejected choice: planner could not size this choice", decision: null, planReport: null };
    }
    personaRule = attempt.rule;
    if (input.choice.kind === "report-plan" && attempt.sourcePlan && attempt.sourceRule) {
      basedOnPlanId = attempt.sourcePlan.planId;
      basedOnRuleKey = `${attempt.sourceRule.id}@${attempt.sourcePlan.ruleHash.slice(0, 8)}`;
    }
    plan = withPersonaProvenance(attempt.plan, basedOnPlanId, basedOnRuleKey);
  }

  const atr14d = plan ? (pctx.features.find((f) => f.symbol === plan!.symbol)?.features["atr14d"]) : undefined;
  const atr14dValue = atr14d && atr14d.kind === "value" ? atr14d.value : 0;
  const ownerProtocol = plan ? buildOwnerProtocol(plan, atr14dValue, pctx.personaCfg, now) : null;

  const existingRevision = latestRevision(args.decisionsRoot, args.date);

  if (existingRevision >= 0 && !args.revise) {
    return { exitCode: 3, message: `decision for ${args.date} already exists; pass --revise to add a new revision`, decision: null, planReport: null };
  }

  if (args.revise) {
    const staleMessage = checkSyncFreshness(args, pctx.manual, now);
    if (staleMessage) return { exitCode: 5, message: staleMessage, decision: null, planReport: null };

    if (existingRevision >= 0) {
      const effective = JSON.parse(
        readFileSync(artifactPath(args.decisionsRoot, args.date, existingRevision), "utf-8"),
      ) as DailyDecision;
      if (effective.plan) {
        const actedOn = pctx.journal.find((t) => t.planId === effective.plan!.planId);
        if (actedOn) {
          return { exitCode: 3, message: `cannot revise: trade "${actedOn.id}" already links to plan "${effective.plan.planId}"`, decision: null, planReport: null };
        }
      }
    }
  }

  const decision: DailyDecision = {
    schemaVersion: 1,
    dateUtc: args.date,
    revision: existingRevision + 1,
    decidedAt: now,
    skillHash: pctx.hash,
    reportPath: reportInfo.path,
    reportSha256: reportInfo.sha256,
    reportDecisionTime: reportInfo.report.decisionTime,
    input,
    validation,
    plan,
    personaRule,
    basedOnPlanId,
    basedOnRuleKey,
    ownerProtocol,
    ownerTimeZone: pctx.personaCfg.ownerTimeZone,
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };

  const path = artifactPath(args.decisionsRoot, args.date, decision.revision);
  writeOnce(path, `${JSON.stringify(decision, null, 2)}\n`);

  const otherOpenTrades: OtherOpenTradeRow[] = pctx.journal
    .filter((t) => t.status === "open" && (plan === null || t.planId !== plan.planId))
    .map((t) => ({ tradeId: t.id, symbol: t.symbol, side: t.side, planId: t.planId }));
  const planReportMd = renderPlanReport(decision, reportInfo.report, otherOpenTrades);
  mkdirSync(args.reportsRoot, { recursive: true });
  writeFileSync(join(args.reportsRoot, `${args.date}.decision.md`), planReportMd);

  return { exitCode: 0, message: `decision written: ${path}`, decision, planReport: planReportMd };
}

interface ManageModeCtx {
  manual: ManualTradingConfig;
  journal: ManualTrade[];
  ruleSet: RuleSet;
  hash: string;
  features: FeatureVector[];
  personaCfg: PersonaConfig;
}

function runManageMode(
  args: DecideArgs, rawInput: unknown, now: number,
  reportInfo: { path: string; raw: string; sha256: string; report: DailyReport },
  mctx: ManageModeCtx,
): RunResult {
  void reportInfo;
  const input = parseManageInput(rawInput);
  if (input === null) {
    return { exitCode: 2, message: "schema_invalid input: does not match ManageInput", decision: null, planReport: null };
  }

  const tradeArg = args.trade!;
  const trade = mctx.journal.find((t) => t.id === tradeArg) ?? null;

  // §5.15 "already acted on" (AC-113b) is checked BEFORE general validation: a trade that has
  // since closed (a new exit fill, a changed exitKind, status -> closed, or any updatedAt later
  // than the effective decision's writtenAt all bump `updatedAt`) would otherwise fail
  // validateManage's own trade_not_open check first (exit 2) — masking the exit-3 "acted on,
  // don't rewrite" case this rule exists for, since a closed trade IS the common real trigger.
  const baseName = `${args.date}.manage.${tradeArg}`;
  const existingRevision = latestRevision(args.decisionsRoot, baseName);
  if (existingRevision >= 0 && !args.revise) {
    return { exitCode: 3, message: `manage decision for ${tradeArg} on ${args.date} already exists; pass --revise to add a new revision`, decision: null, planReport: null };
  }
  if (args.revise) {
    const staleMessage = checkSyncFreshness(args, mctx.manual, now);
    if (staleMessage) return { exitCode: 5, message: staleMessage, decision: null, planReport: null };
    if (existingRevision >= 0) {
      const effective = JSON.parse(
        readFileSync(artifactPath(args.decisionsRoot, baseName, existingRevision), "utf-8"),
      ) as ManageDecision;
      if (trade && trade.updatedAt > effective.writtenAt) {
        return { exitCode: 3, message: `cannot revise: trade "${tradeArg}" has a journal event after the effective manage decision`, decision: null, planReport: null };
      }
    }
  }

  let computedThesis: ManageContext["computedThesis"] = "not_evaluable";
  if (trade) {
    const rule = resolveTradeRule(trade, mctx.ruleSet, args);
    const fv = mctx.features.find((f) => f.symbol === trade.symbol);
    if (rule && fv) computedThesis = evaluateThesis(rule, fv).state;
  }

  const ctx: ManageContext = {
    dateUtc: args.date, tradeArg, trade, computedThesis, personaCfg: mctx.personaCfg, skillHash: mctx.hash, now,
  };
  const validation = validateManage(input, ctx);
  if (!validation.ok) {
    return { exitCode: 2, message: rejectionLines(validation.rejections), decision: null, planReport: null };
  }

  const decision: ManageDecision = {
    schemaVersion: 1,
    dateUtc: args.date,
    tradeId: tradeArg,
    revision: existingRevision + 1,
    writtenAt: now,
    skillHash: mctx.hash,
    input,
    validation,
    tradePlanId: trade?.planId ?? null,
    currentStopPrice: trade?.plannedSnapshot?.stopPrice ?? NaN,
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };

  const path = artifactPath(args.decisionsRoot, baseName, decision.revision);
  writeOnce(path, `${JSON.stringify(decision, null, 2)}\n`);
  return { exitCode: 0, message: `manage decision written: ${path}`, decision, planReport: null };
}

interface ReviewModeCtx {
  manual: ManualTradingConfig;
  journal: ManualTrade[];
  hash: string;
  personaCfg: PersonaConfig;
}

async function runReviewMode(args: DecideArgs, rawInput: unknown, now: number, rctx: ReviewModeCtx, deps: DecideDeps): Promise<RunResult> {
  const input = parseReviewInput(rawInput);
  if (input === null) {
    return { exitCode: 2, message: "schema_invalid input: does not match ReviewInput", decision: null, planReport: null };
  }

  const tradeArg = args.trade!;
  const trade = rctx.journal.find((t) => t.id === tradeArg) ?? null;

  let computed: ReviewContext["computed"] = null;
  if (trade && trade.status === "closed") {
    let klines: Awaited<ReturnType<NonNullable<DecideDeps["fetchKlines"]>>> = [];
    if (deps.fetchKlines) {
      const from = trade.entryFills.reduce((min, f) => Math.min(min, f.time), Number.POSITIVE_INFINITY);
      const to = trade.exitFills.reduce((max, f) => Math.max(max, f.time), 0);
      if (Number.isFinite(from)) {
        klines = await deps.fetchKlines(trade.symbol, "60", from, to, { fetch, sleep: async () => {} });
      }
    }
    computed = reviewClosedTrade(trade, klines ?? []);
  }

  const ctx: ReviewContext = {
    dateUtc: args.date, tradeArg, trade, computed, personaCfg: rctx.personaCfg, skillHash: rctx.hash, now,
  };
  const validation = validateReview(input, ctx);
  if (!validation.ok) {
    return { exitCode: 2, message: rejectionLines(validation.rejections), decision: null, planReport: null };
  }

  const baseName = `${args.date}.review.${tradeArg}`;
  const existingRevision = latestRevision(args.decisionsRoot, baseName);
  if (existingRevision >= 0 && !args.revise) {
    return { exitCode: 3, message: `review decision for ${tradeArg} on ${args.date} already exists; pass --revise to add a new revision`, decision: null, planReport: null };
  }

  const decision: ReviewDecision = {
    schemaVersion: 1,
    dateUtc: args.date,
    tradeId: tradeArg,
    revision: existingRevision + 1,
    writtenAt: now,
    skillHash: rctx.hash,
    input,
    validation,
    computed: computed!,
    disclaimer: "Generated analysis for the owner's review. Not investment advice.",
  };

  const path = artifactPath(args.decisionsRoot, baseName, decision.revision);
  writeOnce(path, `${JSON.stringify(decision, null, 2)}\n`);
  return { exitCode: 0, message: `review decision written: ${path}`, decision, planReport: null };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseDecideArgs(argv, Date.now());
  const deps: DecideDeps = { now: () => Date.now(), readStdin: defaultReadStdin };
  const result = await runDecide(args, deps);
  if (result.exitCode === 0) {
    console.log(result.message);
    if (result.planReport) console.log(`\n${result.planReport}`);
  } else {
    console.error(result.message);
  }
  process.exitCode = result.exitCode;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}

export type { RunResult as DecideResult };
