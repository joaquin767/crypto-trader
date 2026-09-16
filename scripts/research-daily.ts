// research:daily CLI — specs/daily-catalyst-manual-trading.md §5.12 (Phase 2 slice: the rules
// channel only; the AI step is Phase 4b's job — `aiDisabledReason` is hardcoded "config" until
// then, since `ai` config isn't parsed yet, per §9's Phase 2 row).
//
// Order of operations (§5.12): snapshots → features → rule outcomes → rule plans →
// buildReport → write reports/<date>.json + .md. buildReport computes rule outcomes and plans
// internally from ruleSet/features/plannerConfig/breaker/openTrades — see
// src/research/report.ts's header comment for why that reading was chosen over a literal
// separate "compute outcomes, compute plans, then call buildReport" pipeline.
//
// Exit codes: 0 report written; 2 rule-set validation failure (every issue printed, nothing
// written); 3 report already exists for the date and --refetch was not given (file(s)
// unchanged); 4 decision time is in the future.
//
// Usage: node --experimental-strip-types scripts/research-daily.ts --config ./config.json
//   [--date YYYY-MM-DD] [--refetch] [--no-ai] [--snapshot-root <dir>] [--reports-root <dir>]
//   [--rules-path <file>]
// (--snapshot-root/--reports-root/--rules-path are not in the spec's CLI list — like
// snapshot-daily.ts's --snapshot-root, they exist so tests and scratch smoke runs never touch
// the committed data/snapshots or reports/ directories or the repo's own research-rules.json.)

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, resolveManualTradingConfig } from "../src/config.ts";
import type { AdapterDeps } from "../src/research/http.ts";
import { defaultAdapterDeps } from "../src/research/http.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import { writeSnapshot } from "../src/research/snapshot-store.ts";
import { createAllSourceAdapters } from "../src/research/sources/index.ts";
import type { RuleSet } from "../src/research/rules.ts";
import { parseRuleSet, RuleSetValidationError } from "../src/research/rules.ts";
import type { PlannerConfig } from "../src/research/planner.ts";
import type { DailyReport } from "../src/research/report.ts";
import { buildReport, renderReportMarkdown } from "../src/research/report.ts";
import type { SourceSnapshot } from "../src/research/types.ts";
import { resolveDecisionTime } from "./snapshot-daily.ts";

export interface ResearchDailyArgs {
  date: string;
  refetch: boolean;
  configPath: string;
  snapshotRoot: string;
  reportsRoot: string;
  rulesPath: string;
  noAi: boolean;
}

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
    noAi: argv.includes("--no-ai"),
  };
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

export async function runResearchDaily(args: ResearchDailyArgs, deps: AdapterDeps): Promise<ResearchDailyResult> {
  const now = deps.now();
  const latestExisting = latestReportRevision(args.reportsRoot, args.date);
  const decision = decideResearchDailyAction(args, now, latestExisting);
  if (decision.kind === "exit") return { exitCode: decision.code, message: decision.message };

  const config = loadConfig(args.configPath);
  const manual = resolveManualTradingConfig(config);

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

  const report = buildReport({
    dateUtc: args.date,
    decisionTime: resolved.decisionTime,
    now,
    ruleSet,
    ruleSetSha256,
    snapshots,
    features,
    plannerConfig,
    // Phase 2 fixed values (§9's Phase 2 row) — real wiring arrives with later phases:
    breaker: { tripped: false, trigger: null, details: "" }, // circuit breaker: Phase 3+ (journal)
    openTrades: [], // journal integration: Phase 3
    aiDisabledReason: "config", // `ai` config isn't parsed until Phase 4b; --no-ai has no effect yet
  });
  const markdown = renderReportMarkdown(report);

  mkdirSync(args.reportsRoot, { recursive: true });
  const jsonPath = reportFilePath(args.reportsRoot, args.date, decision.revision, "json");
  const mdPath = reportFilePath(args.reportsRoot, args.date, decision.revision, "md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  writeFileSync(mdPath, markdown, { flag: "wx" });

  return { exitCode: 0, report, markdown };
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
