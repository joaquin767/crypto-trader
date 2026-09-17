// research:daily CLI — specs/daily-catalyst-manual-trading.md §5.12, §5.13 (Phase 4b wires the
// AI step in; Phases 1-3 already covered snapshots/features/rules/planner/journal).
//
// Order of operations (§5.12): snapshots → features → rule outcomes → rule plans →
// buildReport → write reports/<date>.json + .md (**the rules report is persisted before any AI
// call**, write-once) → if `ai.enabled` and not `--no-ai`: build AiAnalystInput → runAiAnalyst →
// attachAiAnalyst → rewrite both report files (this second write is the one place this script
// overwrites an already-written report — an AI failure never deletes or alters the rules-report
// content already on disk, since attachAiAnalyst only ever appends to `plans` and replaces
// `aiAnalyst`, §5.6). buildReport computes rule outcomes and plans internally from
// ruleSet/features/plannerConfig/breaker/openTrades — see src/research/report.ts's header
// comment for why that reading was chosen over a literal separate "compute outcomes, compute
// plans, then call buildReport" pipeline.
//
// Exit codes: 0 report written; 2 rule-set validation failure (every issue printed, nothing
// written); 3 report already exists for the date and --refetch was not given (file(s)
// unchanged) — or exists with `aiAnalyst.status: "pending"` (AC-49b: the process died between
// the rules-report write and attachAiAnalyst; message says so instead of the generic one);
// 4 decision time is in the future; 5 manual journal is unreadable (all backups corrupt,
// §5.8a) — no report written.
//
// Usage: node --experimental-strip-types scripts/research-daily.ts --config ./config.json
//   [--date YYYY-MM-DD] [--refetch] [--no-ai] [--notify] [--snapshot-root <dir>] [--reports-root <dir>]
//   [--rules-path <file>] [--journal-path <file>] [--ai-ledger-path <file>]
//   [--ai-rules-root <dir>] [--prompt-path <file>]
// --notify (or config.manual.notifyOnReport) fires a best-effort desktop notification once the
// report is written (§5.16 item 2).
// (--snapshot-root/--reports-root/--rules-path/--journal-path/--ai-ledger-path/--ai-rules-root/
// --prompt-path are not in the spec's CLI list — like snapshot-daily.ts's --snapshot-root, they
// exist so tests and scratch smoke runs never touch the committed data/snapshots, reports/,
// research-rules.json, manual-journal.json, data/ai-usage.jsonl or data/ai-rules/.)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, resolveAiAnalystConfig, resolveManualTradingConfig } from "../src/config.ts";
import type { AdapterDeps } from "../src/research/http.ts";
import { defaultAdapterDeps } from "../src/research/http.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import { writeSnapshot } from "../src/research/snapshot-store.ts";
import { createAllSourceAdapters } from "../src/research/sources/index.ts";
import type { RuleSet } from "../src/research/rules.ts";
import { parseRuleSet, RuleSetValidationError } from "../src/research/rules.ts";
import type { InstrumentFilter, PlannerConfig } from "../src/research/planner.ts";
import { instrumentFilters } from "../src/research/planner.ts";
import type { RuleDefinition } from "../src/research/rules.ts";
import type { DailyReport } from "../src/research/report.ts";
import { attachAiAnalyst, buildReport, renderReportMarkdown } from "../src/research/report.ts";
import type { SourceSnapshot } from "../src/research/types.ts";
import { resolveDecisionTime } from "./snapshot-daily.ts";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "../src/risk/circuit-breaker.ts";
import { computeBreaker } from "../src/journal/breaker.ts";
import { JournalUnreadableError, loadManualJournal } from "../src/journal/manual-journal.ts";
import type { ManualTrade } from "../src/journal/types.ts";
import { dateFromPlanId, loadEffectiveDecision } from "../src/decision/decisions-store.ts";
import type { AiAnalystConfig, AiAnalystSection, AiClientPort } from "../src/research/ai/types.ts";
import { AI_OUTPUT_JSON_SCHEMA } from "../src/research/ai/output-schema.ts";
import { buildAiAnalystInput, promptVersionHash, runAiAnalyst } from "../src/research/ai/analyst.ts";
import { createAnthropicAiClient } from "../src/research/ai/anthropic-client.ts";
import { createClaudeCliAiClient } from "../src/research/ai/claude-cli-client.ts";

// §5.8a / report.ts's LADDER_RESET_BY_BREAKER: until the breaker trip log exists (Phase 4's
// journal-only scope never added one), `ladderResetByBreaker` stays hardcoded `true` for every
// plan attempt — rule and AI alike — fail closed. Duplicated here (not imported) because
// report.ts keeps it module-private; both copies exist for the same normative reason.
const LADDER_RESET_BY_BREAKER = true;

export interface ResearchDailyArgs {
  date: string;
  refetch: boolean;
  configPath: string;
  snapshotRoot: string;
  reportsRoot: string;
  rulesPath: string;
  journalPath: string;
  noAi: boolean;
  aiLedgerPath: string;
  aiRulesRoot: string;
  promptPath: string;
  decisionsRoot: string;
  /** §5.16 item 2: --notify flag, ORed with manual.notifyOnReport (either one turns it on). */
  notify: boolean;
}

/** §5.16 item 2: the subset of node:child_process's `spawn` signature the desktop notification
 *  needs — injectable so tests never spawn a real process. */
export type NotifySpawnFn = (
  command: string,
  args: readonly string[],
  options?: { stdio?: "ignore" },
) => { on(event: "error", listener: (err: Error) => void): void };

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function parseResearchDailyArgs(argv: readonly string[], now: number): ResearchDailyArgs {
  return {
    date: flagValue(argv, "--date") ?? todayUtc(now),
    refetch: argv.includes("--refetch"),
    configPath: flagValue(argv, "--config") ?? "./config.json",
    snapshotRoot: flagValue(argv, "--snapshot-root") ?? "data/snapshots",
    reportsRoot: flagValue(argv, "--reports-root") ?? "reports",
    rulesPath: flagValue(argv, "--rules-path") ?? "./research-rules.json",
    journalPath: flagValue(argv, "--journal-path") ?? "./manual-journal.json",
    noAi: argv.includes("--no-ai"),
    aiLedgerPath: flagValue(argv, "--ai-ledger-path") ?? "data/ai-usage.jsonl",
    aiRulesRoot: flagValue(argv, "--ai-rules-root") ?? "data/ai-rules",
    promptPath: flagValue(argv, "--prompt-path") ?? "prompts/ai-analyst.md",
    decisionsRoot: flagValue(argv, "--decisions-root") ?? "data/decisions",
    notify: argv.includes("--notify"),
  };
}

/** §5.16 item 2: best-effort, fire-and-forget desktop notification once a report is written.
 *  Never awaits the child, never throws, never changes the caller's exit code — a missing
 *  `notify-send` binary or any other spawn failure prints one stderr line and is otherwise
 *  ignored. */
function notifyReportWritten(date: string, report: DailyReport, spawnFn: NotifySpawnFn): void {
  const ruleCount = report.plans.filter((p) => p.kind === "plan" && p.origin === "rules-file").length;
  const aiCount = report.plans.filter((p) => p.kind === "plan" && p.origin === "ai-analyst").length;
  const message = `${date} report written: ${ruleCount} rule plans, ${aiCount} AI plans, ai ${report.aiAnalyst.status}`;
  try {
    const child = spawnFn("notify-send", ["crypto-trader", message], { stdio: "ignore" });
    child.on("error", (err) => {
      console.error(`[research:daily] desktop notification failed: ${(err as Error).message}`);
    });
  } catch (err) {
    console.error(`[research:daily] desktop notification failed: ${(err as Error).message}`);
  }
}

function reportFilePath(reportsRoot: string, date: string, revision: number, ext: "json" | "md"): string {
  return join(reportsRoot, revision > 0 ? `${date}.r${revision}.${ext}` : `${date}.${ext}`);
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highest existing report revision for the date, or -1 if no report exists yet. Only `.json`
 *  files are inspected (each JSON report always has a matching `.md` written alongside it, so
 *  one file family is enough to detect existence). */
export function latestReportRevision(reportsRoot: string, date: string): number {
  if (!existsSync(reportsRoot)) return -1;
  const re = new RegExp(`^${escapeForRegExp(date)}(?:\\.r(\\d+))?\\.json$`);
  let latest = -1;
  for (const file of readdirSync(reportsRoot)) {
    const m = re.exec(file);
    if (!m) continue;
    const rev = m[1] ? Number.parseInt(m[1], 10) : 0;
    if (rev > latest) latest = rev;
  }
  return latest;
}

export type ResearchDailyDecision =
  | { kind: "proceed"; scheduledDecisionTime: number; revision: number }
  | { kind: "exit"; code: 3 | 4; message: string };

/** Factored out from runResearchDaily so the exit-3/exit-4 logic is unit-testable without
 *  touching the filesystem or network. */
export function decideResearchDailyAction(
  args: Pick<ResearchDailyArgs, "date" | "refetch">,
  now: number,
  latestExistingRevision: number,
): ResearchDailyDecision {
  const scheduledDecisionTime = Date.parse(`${args.date}T00:15:00Z`);
  if (!Number.isFinite(scheduledDecisionTime)) {
    return { kind: "exit", code: 4, message: `invalid --date "${args.date}"` };
  }
  if (scheduledDecisionTime > now) {
    return { kind: "exit", code: 4, message: `decision time ${new Date(scheduledDecisionTime).toISOString()} is in the future` };
  }
  if (latestExistingRevision >= 0 && !args.refetch) {
    return { kind: "exit", code: 3, message: `report for ${args.date} already exists; pass --refetch to add a new revision` };
  }
  const revision = latestExistingRevision >= 0 ? latestExistingRevision + 1 : 0;
  return { kind: "proceed", scheduledDecisionTime, revision };
}

export interface ResearchDailyResult {
  exitCode: number;
  message?: string;
  report?: DailyReport;
  markdown?: string;
}

/** AC-49b: when the exit-3 case ("report already exists, no --refetch") is hit and that report
 *  was left `aiAnalyst.status: "pending"` (the process died between the rules-report write and
 *  attachAiAnalyst, §7), the printed message says so instead of the generic "already exists"
 *  text. A report that fails to read/parse falls back to the generic message — this is a nicer
 *  error string, not a behavior-changing check. */
function pendingAiMessage(reportsRoot: string, date: string, revision: number): string | null {
  try {
    const report = JSON.parse(readFileSync(reportFilePath(reportsRoot, date, revision, "json"), "utf-8")) as DailyReport;
    if (report.aiAnalyst.status === "pending") {
      return `AI step incomplete for ${date}; rerun with --refetch`;
    }
  } catch {
    // fall through to the generic message
  }
  return null;
}

export async function runResearchDaily(
  args: ResearchDailyArgs,
  deps: AdapterDeps,
  // Default picks the adapter by cfg.provider ("claude-cli" default — see AiAnalystConfig);
  // callers/tests may still inject their own factory (e.g. a fake port) regardless of provider.
  aiClientFactory: (cfg: AiAnalystConfig, snapshotRoot: string) => AiClientPort = (cfg, snapshotRoot) =>
    cfg.provider === "claude-cli" ? createClaudeCliAiClient(cfg, snapshotRoot) : createAnthropicAiClient(cfg, snapshotRoot),
  // §5.16 item 2: real node:child_process spawn by default; tests inject a fake. Cast because
  // node:child_process's `spawn` is a large overloaded type that TS won't structurally match
  // against this narrower call shape — the (command, args, options) call below is a real overload.
  spawnFn: NotifySpawnFn = spawn as unknown as NotifySpawnFn,
): Promise<ResearchDailyResult> {
  const now = deps.now();
  const latestExisting = latestReportRevision(args.reportsRoot, args.date);
  const decision = decideResearchDailyAction(args, now, latestExisting);
  if (decision.kind === "exit") {
    if (decision.code === 3) {
      const pendingMessage = pendingAiMessage(args.reportsRoot, args.date, latestExisting);
      if (pendingMessage) return { exitCode: 3, message: pendingMessage };
    }
    return { exitCode: decision.code, message: decision.message };
  }

  const config = loadConfig(args.configPath);
  const manual = resolveManualTradingConfig(config);
  const aiCfg = resolveAiAnalystConfig(config);
  const aiDisabledReason: null | "config" | "cli-flag" = args.noAi ? "cli-flag" : !aiCfg.enabled ? "config" : null;

  // Rule set is read and validated before any fetch: an invalid file must never spend the
  // fetch budget or write a report (§7: "research-rules.json invalid → Exit 2, no report
  // written, all issues printed").
  let ruleSetRaw: string;
  try {
    ruleSetRaw = deps.readFile(args.rulesPath);
  } catch (err) {
    return { exitCode: 2, message: `cannot read rules file at "${args.rulesPath}": ${(err as Error).message}` };
  }
  let ruleSetJson: unknown;
  try {
    ruleSetJson = JSON.parse(ruleSetRaw);
  } catch (err) {
    return { exitCode: 2, message: `invalid JSON in "${args.rulesPath}": ${(err as Error).message}` };
  }
  let ruleSet: RuleSet;
  try {
    ruleSet = parseRuleSet(ruleSetJson, config.symbols);
  } catch (err) {
    if (err instanceof RuleSetValidationError) {
      const lines = err.issues.map((i) => `  ${i.path}: ${i.message}`);
      return { exitCode: 2, message: `research-rules.json failed validation:\n${lines.join("\n")}` };
    }
    throw err;
  }
  const ruleSetSha256 = createHash("sha256").update(ruleSetRaw).digest("hex");

  // §5.8a "research:daily wiring": missing journal file → empty journal; unreadable (all
  // backups corrupt) → exit 5, no report written. Read before any fetch, same reasoning as the
  // rule-set gate above (never spend the fetch budget on a run that can't complete).
  let journal: ManualTrade[];
  try {
    journal = loadManualJournal({ path: args.journalPath });
  } catch (err) {
    if (err instanceof JournalUnreadableError) {
      return { exitCode: 5, message: `manual journal is unreadable: ${err.message}` };
    }
    throw err;
  }

  const adapters = createAllSourceAdapters(deps);
  const snapshots: SourceSnapshot[] = [];
  for (const adapter of adapters) {
    const snap = await adapter.fetch(decision.scheduledDecisionTime, config.symbols);
    writeSnapshot(args.date, snap, { revision: decision.revision, rootDir: args.snapshotRoot });
    snapshots.push(snap);
  }

  const resolved = resolveDecisionTime(decision.scheduledDecisionTime, snapshots.map((s) => s.fetchedAt));
  const features = buildFeatures(snapshots, config.symbols, resolved.decisionTime, DEFAULT_STALENESS_MS);

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

  const openTrades = journal.filter((t) => t.status === "open");
  const liveClosedTradesByRule: Record<string, number> = {};
  for (const t of journal) {
    if (t.venue === "bybit-live" && t.status === "closed" && t.ruleId !== null) {
      liveClosedTradesByRule[t.ruleId] = (liveClosedTradesByRule[t.ruleId] ?? 0) + 1;
    }
  }
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

  // §5.13/AC-53: an open AI-origin trade's thesis needs its persisted rule from
  // data/ai-rules/<planId>.json — research-rules.json never contains an "ai-analyst" rule. A
  // trade with no planId, or whose file is missing/corrupt, is simply left out of this map;
  // buildReport's own fallback then reports that thesis as "not_evaluable".
  const aiRules: Record<string, RuleDefinition> = {};
  for (const t of openTrades) {
    if (t.ruleId === null || t.planId === null) continue;
    if (t.ruleId.startsWith("persona-")) continue; // persona-origin: loaded from data/decisions/ below
    try {
      aiRules[t.ruleId] = JSON.parse(readFileSync(join(args.aiRulesRoot, `${t.planId}.json`), "utf-8")) as RuleDefinition;
    } catch {
      // missing or corrupt -> not_evaluable, handled by buildReport's own fallback
    }
  }

  // §5.8a revision-3 paragraph: an open persona-origin trade's rule for `evaluateThesis` lives in
  // the decision file's `personaRule`, not in data/ai-rules/ — a missing/unreadable file leaves
  // it out of this map, and buildReport's own fallback then reports "not_evaluable" (AC-118).
  const personaRules: Record<string, RuleDefinition> = {};
  for (const t of openTrades) {
    if (t.ruleId === null || t.planId === null || !t.ruleId.startsWith("persona-")) continue;
    const date = dateFromPlanId(t.planId);
    if (date === null) continue;
    const decision = loadEffectiveDecision(args.decisionsRoot, date);
    if (decision?.personaRule) personaRules[t.ruleId] = decision.personaRule;
  }

  const report = buildReport({
    dateUtc: args.date,
    decisionTime: resolved.decisionTime,
    now,
    ruleSet,
    ruleSetSha256,
    snapshots,
    features,
    plannerConfig,
    breaker,
    openTrades,
    liveClosedTradesByRule,
    aiRules,
    personaRules,
    aiDisabledReason,
  });
  const markdown = renderReportMarkdown(report);

  mkdirSync(args.reportsRoot, { recursive: true });
  const jsonPath = reportFilePath(args.reportsRoot, args.date, decision.revision, "json");
  const mdPath = reportFilePath(args.reportsRoot, args.date, decision.revision, "md");
  // Write-once (§5.12: "the rules report is persisted before any AI call"). If the AI step runs
  // below, these exact files are overwritten in place with attachAiAnalyst's output — never a
  // second write-once, since that would throw on the file this line just created.
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  writeFileSync(mdPath, markdown, { flag: "wx" });

  const notifyEnabled = manual.notifyOnReport || args.notify;

  if (aiDisabledReason !== null) {
    if (notifyEnabled) notifyReportWritten(args.date, report, spawnFn);
    return { exitCode: 0, report, markdown };
  }

  // ── AI analyst step (§5.13) — runs only when enabled and not skipped by --no-ai. Never
  // throws: runAiAnalyst itself resolves to an "unavailable"/"skipped_budget" section instead of
  // rejecting for any API/verification/budget problem (§5.13), so the already-written rules
  // report is always followed by a final report, one way or another.
  const systemPrompt = readFileSync(args.promptPath, "utf-8");
  const hash = promptVersionHash(systemPrompt, AI_OUTPUT_JSON_SCHEMA, aiCfg);
  const instruments: Record<string, InstrumentFilter | null> = instrumentFilters(snapshots, config.symbols);

  const aiInput = buildAiAnalystInput({
    dateUtc: args.date,
    decisionTime: resolved.decisionTime,
    promptVersionHash: hash,
    systemPrompt,
    sources: report.sources,
    features,
    outcomes: report.outcomes,
    rulePlans: report.plans.filter((p) => p.origin === "rules-file"),
    configSymbols: config.symbols,
    openTrades,
    openTradeThesis: report.openTradeThesis,
    now,
  });

  // AI plans count open trades AFTER rule plans (§5.13): rule plans already consumed
  // `maxOpenManualTrades` slots first, one per "plan"-kind entry now in `report.plans`.
  const openTradeCountAfterRules = openTrades.length + report.plans.filter((p) => p.kind === "plan").length;
  const aiRuleId = `ai-analyst-${hash.slice(0, 8)}`;

  // runAiAnalyst is documented to never reject (§5.13, "MUST resolve, never throws"), but the
  // rules report is already durably written by this point — a bug there (or in the injected
  // port) must not crash the whole run and lose that already-good report. Belt and suspenders.
  let aiSection: AiAnalystSection;
  try {
    aiSection = await runAiAnalyst(aiInput, aiClientFactory(aiCfg, args.snapshotRoot), aiCfg, {
      cfg: plannerConfig,
      openTradeCount: openTradeCountAfterRules,
      breakerTripped: breaker.tripped,
      dateUtc: args.date,
      features,
      liveClosedTradesForAi: liveClosedTradesByRule[aiRuleId] ?? 0,
      ladderResetByBreaker: LADDER_RESET_BY_BREAKER,
      ledgerPath: args.aiLedgerPath,
      now,
      instruments,
      aiRulesRoot: args.aiRulesRoot,
    });
  } catch (err) {
    aiSection = {
      status: "unavailable", reason: `unexpected error: ${(err as Error).message}`, model: aiCfg.model,
      provider: aiCfg.provider, servedByModel: null, promptVersionHash: hash,
      costUsd: 0, monthToDateUsd: 0, listCostUsd: 0, regimeSummary: null,
      assessments: [], plans: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [], rejected: [],
    };
  }

  const finalReport = attachAiAnalyst(report, aiSection);
  const finalMarkdown = renderReportMarkdown(finalReport);
  writeFileSync(jsonPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  writeFileSync(mdPath, finalMarkdown);

  if (notifyEnabled) notifyReportWritten(args.date, finalReport, spawnFn);

  return { exitCode: 0, report: finalReport, markdown: finalMarkdown };
}

async function main(): Promise<void> {
  const deps = defaultAdapterDeps();
  const args = parseResearchDailyArgs(process.argv.slice(2), deps.now());
  const result = await runResearchDaily(args, deps);
  if (result.exitCode === 0) {
    console.log(`report written for ${args.date} (exit 0)`);
  }
  if (result.message) {
    console.error(result.message);
  }
  process.exitCode = result.exitCode;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
