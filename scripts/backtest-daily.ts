// backtest:daily CLI — specs/daily-catalyst-manual-trading.md §5.12 `backtest:daily` bullet,
// §5.10a "Windows and leakage" / "Ledger and multiple testing" / "d1-check".
//
// Usage: node --experimental-strip-types scripts/backtest-daily.ts --config ./config.json
//   --rule <id> --mode dev|holdout|d1-check
//   [--history-dir data/history] [--reports-root reports] [--journal-path manual-journal.json]
//   [--seed N] [--slippage-bps N]
// (--config/--rules-path/--artifacts-dir/--ledger-path/--docs-validation-dir/--resamples/
// --permutation-runs are not in the spec's literal CLI list — like research-daily.ts's
// --snapshot-root, they exist so tests and scratch smoke runs never touch the committed
// research-rules.json/data/validation/daily/holdout-ledger.jsonl, and so the bootstrap/
// permutation costs are tunable in tests. None of them touch the holdout window itself — §5.10a
// is explicit that the CLI has NO flags for that.)
//
// Exit codes: 0 iff verdict is "edge_confirmed" (holdout) / "paper_passed" (d1-check); 1
// otherwise, including every refusal and dev's AC-22 leakage assertion. Dev mode never exits
// non-zero for its own verdict ("dev_only" always exits 0 once the leakage assertion passes) —
// it is not a gate, just a preview.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, resolveManualTradingConfig } from "../src/config.ts";
import type { PlannerConfig } from "../src/research/planner.ts";
import type { RuleDefinition, RuleSet } from "../src/research/rules.ts";
import { parseRuleSet, ruleHash as computeRuleHash, RuleSetValidationError } from "../src/research/rules.ts";
import type { SourceId } from "../src/research/types.ts";
import { loadHistory } from "../src/backtest-daily/history-store.ts";
import type { HistoryFile } from "../src/backtest-daily/history-store.ts";
import { replayRule } from "../src/backtest-daily/replay.ts";
import type { ReplayResult } from "../src/backtest-daily/replay.ts";
import type { SimTrade } from "../src/backtest-daily/simulate.ts";
import { runPermutation } from "../src/backtest-daily/permutation.ts";
import {
  appendLedger,
  globalEvaluationIndex,
  HOLDOUT_END_MS,
  HOLDOUT_START_MS,
  readLedger,
  ruleEvaluationIndex,
  runGateD0,
} from "../src/backtest-daily/gate-d0.ts";
import type { GateD0Report, LedgerEntry } from "../src/backtest-daily/gate-d0.ts";
import {
  parseExplainedDates,
  ruleFeatureSourceIds,
  runGateD1,
  selectD0HoldoutArtifact,
  selectPaperTradesForRule,
  unexplainedIncompleteDays,
} from "../src/backtest-daily/gate-d1.ts";
import type { D1Review, DayReportSummary, GateD1Report } from "../src/backtest-daily/gate-d1.ts";
import { bootstrapCi90, DEFAULT_SEED, maxDrawdownR, permutationPValue, topSymbolShare } from "../src/backtest-daily/stats.ts";
import { firstEntryTime, reviewClosedTrade } from "../src/journal/trade-analytics.ts";
import { JournalUnreadableError, loadManualJournal } from "../src/journal/manual-journal.ts";
import type { ManualTrade } from "../src/journal/types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const AI_PREFIX = "ai-analyst-";
// Revision 3 (§8.5, §5.10a "AI ids in d1-check"): a `persona-*` id is treated exactly like an
// `ai-analyst-*` one — synthetic, always forwardOnly, hash taken from the id's 8-char prefix.
const PERSONA_PREFIX = "persona-";

// ── deps (git/time/fs injected so tests never shell out or touch real files) ───────────────────

export interface BacktestDeps {
  now: () => number;
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
  writeFile: (path: string, content: string) => void;
  mkdir: (path: string) => void;
  listDir: (path: string) => string[];
  /** true = uncommitted changes to the rules file actually being loaded (or it is untracked); false = clean;
   *  null = git unavailable or the check failed for another reason (§5.10a treats both as a refusal). */
  gitRulesFileDirty: (rulesPath: string) => boolean | null;
  /** Newest commit touching the rules file actually being loaded; null if unavailable or untracked. */
  gitRulesFileCommit: (rulesPath: string) => string | null;
}

export function defaultBacktestDeps(): BacktestDeps {
  return {
    now: () => Date.now(),
    readFile: (p) => readFileSync(p, "utf-8"),
    fileExists: (p) => existsSync(p),
    writeFile: (p, content) => writeFileSync(p, content),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    listDir: (p) => (existsSync(p) ? readdirSync(p) : []),
    gitRulesFileDirty: (rulesPath) => {
      try {
        // An untracked file has no committed version, so it can never count as pre-registered.
        execFileSync("git", ["ls-files", "--error-unmatch", "--", rulesPath], { stdio: "ignore" });
      } catch (err) {
        const status = (err as { status?: number | null }).status;
        return status === 1 ? true : null;
      }
      try {
        execFileSync("git", ["diff", "--quiet", "HEAD", "--", rulesPath], { stdio: "ignore" });
        return false;
      } catch (err) {
        const status = (err as { status?: number | null }).status;
        return status === 1 ? true : null; // 1 = dirty; anything else (ENOENT, no HEAD, ...) = unavailable
      }
    },
    gitRulesFileCommit: (rulesPath) => {
      try {
        const out = execFileSync("git", ["log", "-1", "--format=%H", "--", rulesPath], { encoding: "utf-8" }).trim();
        return out.length > 0 ? out : null;
      } catch {
        return null;
      }
    },
  };
}

// ── args ─────────────────────────────────────────────────────────────────────────────────────

export interface BacktestDailyArgs {
  rule: string;
  mode: "dev" | "holdout" | "d1-check";
  configPath: string;
  rulesPath: string;
  historyDir: string;
  reportsRoot: string;
  journalPath: string;
  artifactsDir: string;
  ledgerPath: string;
  docsValidationDir: string;
  seed: number;
  slippageBps: number;
  resamples: number;
  permutationRuns: number;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Flags that change what a gate reads, where its budget lives, or how its statistics are computed. They are
 *  dev-only: in holdout and d1-check mode a different ledger, rules file, history, journal, reports, artifacts
 *  directory, seed or resample count would let the multiple-testing budget or pre-registration be bypassed. */
export const GATE_LOCKED_FLAGS = [
  "--rules-path", "--history-dir", "--reports-root", "--journal-path", "--artifacts-dir", "--ledger-path",
  "--docs-validation-dir", "--seed", "--resamples", "--permutation-runs",
] as const;
export const MIN_GATE_SLIPPAGE_BPS = 5;

export function parseBacktestDailyArgs(argv: readonly string[]): BacktestDailyArgs {
  const rule = flagValue(argv, "--rule");
  const mode = flagValue(argv, "--mode");
  if (!rule || (mode !== "dev" && mode !== "holdout" && mode !== "d1-check")) {
    throw new Error("usage: backtest-daily.ts --rule <id> --mode dev|holdout|d1-check [options]");
  }
  if (mode !== "dev") {
    const locked = GATE_LOCKED_FLAGS.filter((f) => argv.includes(f));
    if (locked.length > 0) {
      throw new Error(`${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} only allowed with --mode dev; gate modes use fixed paths and statistics`);
    }
    const slip = flagValue(argv, "--slippage-bps");
    if (slip !== undefined && !(Number.isFinite(Number(slip)) && Number(slip) >= MIN_GATE_SLIPPAGE_BPS)) {
      throw new Error(`--slippage-bps in gate modes must be a number >= ${MIN_GATE_SLIPPAGE_BPS} (it may only make costs more conservative)`);
    }
  }
  for (const f of ["--seed", "--slippage-bps", "--resamples", "--permutation-runs"]) {
    const v = flagValue(argv, f);
    if (v !== undefined && !Number.isFinite(Number(v))) throw new Error(`${f} must be a number`);
  }
  return {
    rule,
    mode,
    configPath: flagValue(argv, "--config") ?? "./config.json",
    rulesPath: flagValue(argv, "--rules-path") ?? "./research-rules.json",
    historyDir: flagValue(argv, "--history-dir") ?? "data/history",
    reportsRoot: flagValue(argv, "--reports-root") ?? "reports",
    journalPath: flagValue(argv, "--journal-path") ?? "./manual-journal.json",
    artifactsDir: flagValue(argv, "--artifacts-dir") ?? "data/validation/daily",
    ledgerPath: flagValue(argv, "--ledger-path") ?? "data/validation/daily/holdout-ledger.jsonl",
    docsValidationDir: flagValue(argv, "--docs-validation-dir") ?? "docs/validation",
    seed: Number(flagValue(argv, "--seed") ?? DEFAULT_SEED),
    slippageBps: Number(flagValue(argv, "--slippage-bps") ?? 5),
    resamples: Number(flagValue(argv, "--resamples") ?? 10_000),
    permutationRuns: Number(flagValue(argv, "--permutation-runs") ?? 1_000),
  };
}

// ── shared helpers ───────────────────────────────────────────────────────────────────────────

function utcDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDaysInclusive(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  let cursor = Date.parse(`${utcDateStr(fromMs)}T00:00:00Z`);
  const end = Date.parse(`${utcDateStr(toMs)}T00:00:00Z`);
  while (cursor <= end) {
    days.push(utcDateStr(cursor));
    cursor += DAY_MS;
  }
  return days;
}

function loadRuleSet(rulesPath: string, configSymbols: readonly string[], deps: BacktestDeps): RuleSet {
  const raw = deps.readFile(rulesPath);
  const json = JSON.parse(raw);
  return parseRuleSet(json, configSymbols);
}

function buildPlannerConfig(config: ReturnType<typeof loadConfig>): PlannerConfig {
  const manual = resolveManualTradingConfig(config);
  return {
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
}

/** Not Math.min(...spread): a symbol's rows across a multi-year 1h history file can number in
 *  the hundreds of thousands, which overflows the call stack when spread into Math.min. */
function minOf(values: readonly number[]): number {
  let min = values[0]!;
  for (const v of values) if (v < min) min = v;
  return min;
}

function symbolFirstKlineTimes(history: readonly HistoryFile[], symbols: readonly string[]): { symbol: string; firstKlineTime: number }[] {
  const daily = history.find((h) => h.sourceId === "bybit-klines-1d");
  const hourly = history.find((h) => h.sourceId === "bybit-klines-1h");
  return symbols.map((symbol) => {
    const times = [
      ...(daily?.rows.filter((r) => r.key === symbol).map((r) => r.observedFor) ?? []),
      ...(hourly?.rows.filter((r) => r.key === symbol).map((r) => r.observedFor) ?? []),
    ];
    return { symbol, firstKlineTime: times.length > 0 ? minOf(times) : 0 };
  });
}

function historyCoverageOf(history: readonly HistoryFile[]): GateD0Report["historyCoverage"] {
  const coverage: GateD0Report["historyCoverage"] = {};
  for (const h of history) {
    coverage[h.sourceId] = { from: h.coverage.from, to: h.coverage.to, rows: h.rows.length };
  }
  return coverage;
}

/** Writes `content` to `<dir>/<baseName>.json`, or `<dir>/<baseName>-rN.json` for the smallest N
 *  that doesn't already exist — an artifact file is never overwritten (§5.10a). */
function writeArtifactNeverOverwrite(deps: BacktestDeps, dir: string, baseName: string, content: string): string {
  deps.mkdir(dir);
  let n = 0;
  for (;;) {
    const suffix = n === 0 ? "" : `-r${n}`;
    const path = join(dir, `${baseName}${suffix}.json`);
    if (!deps.fileExists(path)) {
      deps.writeFile(path, content);
      return path;
    }
    n++;
  }
}

/** The report file (any revision) for one UTC date, highest revision wins — same naming
 *  convention as scripts/research-daily.ts's latestReportRevision. */
function findLatestReportPath(reportsRoot: string, date: string, deps: BacktestDeps): string | null {
  if (!deps.fileExists(reportsRoot)) return null;
  const re = new RegExp(`^${date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.r(\\d+))?\\.json$`);
  let latest = -1;
  let latestName: string | null = null;
  for (const file of deps.listDir(reportsRoot)) {
    const m = re.exec(file);
    if (!m) continue;
    const rev = m[1] ? Number.parseInt(m[1], 10) : 0;
    if (rev > latest) {
      latest = rev;
      latestName = file;
    }
  }
  return latestName ? join(reportsRoot, latestName) : null;
}

function dayReportSummary(reportsRoot: string, date: string, deps: BacktestDeps): DayReportSummary {
  const path = findLatestReportPath(reportsRoot, date, deps);
  if (path === null) return { date, found: false, nonOkSources: [] };
  let parsed: { sources?: { sourceId: SourceId; status: string }[] };
  try {
    parsed = JSON.parse(deps.readFile(path));
  } catch {
    return { date, found: false, nonOkSources: [] };
  }
  const nonOk = (parsed.sources ?? []).filter((s) => s.status !== "ok").map((s) => s.sourceId);
  return { date, found: true, nonOkSources: nonOk };
}

/** ai-analyst-<hash8> ids are synthetic (§8.4, §5.10a "d1-check"): built by aiIdeaToRule, never
 *  present in research-rules.json. They are always forwardOnly; "the hash taken from the id" is
 *  the id's own <hash8> suffix. */
function isAiAnalystId(id: string): boolean {
  return id.startsWith(AI_PREFIX);
}

/** persona-<hash8> ids are synthetic too (§8.5, "AI ids in d1-check"): built by
 *  personaIdeaToRule/reportPlanToPersonaRule, never present in research-rules.json. Same
 *  treatment as an ai-analyst-* id — always forwardOnly, hash from the id's 8-char prefix. */
function isPersonaId(id: string): boolean {
  return id.startsWith(PERSONA_PREFIX);
}

interface RuleIdentity {
  ruleId: string;
  ruleHash: string;
  forwardOnly: boolean;
  origin: "rules-file" | "ai-analyst" | "persona";
  rule: RuleDefinition | null; // null for a synthetic ai-analyst-*/persona-* identity
}

function resolveRuleIdentity(id: string, ruleSet: RuleSet): RuleIdentity | null {
  if (isAiAnalystId(id)) {
    return { ruleId: id, ruleHash: id.slice(AI_PREFIX.length), forwardOnly: true, origin: "ai-analyst", rule: null };
  }
  if (isPersonaId(id)) {
    return { ruleId: id, ruleHash: id.slice(PERSONA_PREFIX.length), forwardOnly: true, origin: "persona", rule: null };
  }
  const rule = ruleSet.rules.find((r) => r.id === id);
  if (!rule) return null;
  return { ruleId: rule.id, ruleHash: computeRuleHash(rule), forwardOnly: rule.forwardOnly, origin: rule.origin, rule };
}

export interface BacktestDailyResult {
  exitCode: number;
  message?: string;
  artifactPath?: string;
}

// ── dev mode ─────────────────────────────────────────────────────────────────────────────────

const DEV_FIRST_DECISION_DAY = "2024-01-11"; // first US spot BTC ETF trading day (§8.1)

/** Largest day-aligned timestamp t with t + (maxHoldDays+1)*DAY_MS < holdoutStart, as a UTC date
 *  string (§5.10a "Dev mode"). */
function lastDevDecisionDay(maxHoldDays: number): string {
  const limit = HOLDOUT_START_MS - (maxHoldDays + 1) * DAY_MS - 1;
  return utcDateStr(Math.floor(limit / DAY_MS) * DAY_MS);
}

/** AC-22's second line of defense: even though dev mode's own window/cutoffMs already make this
 *  impossible, explicitly re-check every sim trade before writing the artifact. Exported so it
 *  can be unit-tested directly (constructing a real leak through the full pipeline would require
 *  breaking the cutoff enforcement covered elsewhere — AC-84). */
export function findHoldoutLeak(trades: readonly SimTrade[], holdoutStart: number): SimTrade | null {
  return trades.find((t) => t.entryTime >= holdoutStart) ?? null;
}

async function runDev(args: BacktestDailyArgs, deps: BacktestDeps, rule: RuleDefinition, plannerConfig: PlannerConfig): Promise<BacktestDailyResult> {
  const history = loadHistory(args.historyDir);
  const lastDay = lastDevDecisionDay(rule.maxHoldDays);
  const cutoffMs = HOLDOUT_START_MS;

  const replay: ReplayResult = replayRule({
    rule, history, plannerConfig,
    firstDecisionDay: DEV_FIRST_DECISION_DAY, lastDecisionDay: lastDay,
    cutoffMs, slippageBps: args.slippageBps,
  });

  // AC-22 second line of defense: dev must never simulate a trade whose entry reaches the
  // holdout, even though firstDecisionDay/lastDecisionDay/cutoffMs already make that impossible.
  const leaked = findHoldoutLeak(replay.trades, HOLDOUT_START_MS);
  if (leaked) {
    return { exitCode: 1, message: `dev mode leaked into the holdout: trade ${leaked.planId} has entryTime >= holdoutStart` };
  }

  const permutation = runPermutation({
    rule, history, plannerConfig, trades: replay.trades, eligibleDays: replay.eligibleDays,
    cutoffMs, slippageBps: args.slippageBps, runs: args.permutationRuns, seed: args.seed,
  });

  const closedTrades = replay.trades.length;
  const decisionDaysWithTrades = new Set(replay.trades.map((t) => t.decisionDay)).size;
  const meanR = closedTrades > 0 ? replay.trades.reduce((a, t) => a + t.rMultiple, 0) / closedTrades : 0;
  const ci90 = closedTrades > 0 ? bootstrapCi90(replay.trades, args.resamples, args.seed) : ([0, 0] as [number, number]);
  const pValue = permutationPValue(meanR, permutation.meanRs);

  const command = `backtest:daily --rule ${rule.id} --mode dev`;
  const now = deps.now();
  const report = {
    schemaVersion: 1, generatedAt: now, command, ruleId: rule.id, ruleHash: computeRuleHash(rule), mode: "dev" as const,
    firstDecisionDay: DEV_FIRST_DECISION_DAY, lastDecisionDay: lastDay, cutoffMs,
    closedTrades, decisionDaysWithTrades, meanR, bootstrapCi90: ci90,
    permutationPValue: pValue, permutationRunsCompleted: permutation.meanRs.length,
    topSymbolShare: topSymbolShare(replay.trades), maxDrawdownR: maxDrawdownR(replay.trades),
    seed: args.seed, slippageBps: args.slippageBps, unfilledCount: replay.unfilled.length,
    symbols: symbolFirstKlineTimes(history, rule.symbols), historyCoverage: historyCoverageOf(history),
    verdict: "dev_only" as const,
  };

  const path = writeArtifactNeverOverwrite(deps, args.artifactsDir, `dev-${rule.id}-${utcDateStr(now)}`, `${JSON.stringify(report, null, 2)}\n`);
  return { exitCode: 0, artifactPath: path };
}

// ── holdout mode ─────────────────────────────────────────────────────────────────────────────

async function runHoldout(
  args: BacktestDailyArgs,
  deps: BacktestDeps,
  ruleSet: RuleSet,
  plannerConfig: PlannerConfig,
): Promise<BacktestDailyResult> {
  const identity = resolveRuleIdentity(args.rule, ruleSet);
  if (identity === null) {
    return { exitCode: 1, message: `refused: rule "${args.rule}" is not in research-rules.json` };
  }
  if (identity.forwardOnly) {
    return { exitCode: 1, message: `refused: rule "${identity.ruleId}" is forwardOnly (§8.1: forwardOnly rules cannot take Gate D0)` };
  }
  if (identity.origin !== "rules-file") {
    return { exitCode: 1, message: `refused: rule "${identity.ruleId}" origin is "${identity.origin}", not "rules-file"` };
  }
  const dirty = deps.gitRulesFileDirty(args.rulesPath);
  if (dirty !== false) {
    return {
      exitCode: 1,
      message: dirty === null
        ? "refused: git is unavailable to verify research-rules.json is committed (A24 pre-registration)"
        : "refused: research-rules.json has uncommitted changes (A24 pre-registration)",
    };
  }

  let existingEntries: LedgerEntry[];
  try {
    existingEntries = readLedger(args.ledgerPath);
  } catch (err) {
    return { exitCode: 1, message: `refused: ${(err as Error).message}` };
  }
  const windowMismatch = existingEntries.some((e) => e.holdoutStart !== HOLDOUT_START_MS || e.holdoutEnd !== HOLDOUT_END_MS);
  if (windowMismatch) {
    return {
      exitCode: 1,
      message: "refused: the ledger contains an entry for a different holdout window (§5.10a: move it aside in a reviewed commit)",
    };
  }

  const rule = identity.rule!; // origin === "rules-file" guarantees a real rule object
  const rulesFileCommit = deps.gitRulesFileCommit(args.rulesPath);
  if (rulesFileCommit === null) {
    return { exitCode: 1, message: "refused: could not resolve research-rules.json's commit hash" };
  }

  const command = `backtest:daily --rule ${rule.id} --mode holdout`;
  const now = deps.now();
  const entry: LedgerEntry = {
    time: now, ruleId: rule.id, ruleHash: identity.ruleHash, rulesFileCommit, command,
    holdoutStart: HOLDOUT_START_MS, holdoutEnd: HOLDOUT_END_MS, seed: args.seed, slippageBps: args.slippageBps,
  };
  // Appended BEFORE simulation starts (§5.10a): a run that crashes below still consumes budget.
  appendLedger(args.ledgerPath, entry);

  const entries = readLedger(args.ledgerPath);
  const rIdx = ruleEvaluationIndex(entries, rule.id);
  const gIdx = globalEvaluationIndex(entries);

  const history = loadHistory(args.historyDir);
  const cutoffMs = Math.min(HOLDOUT_END_MS + (rule.maxHoldDays + 1) * DAY_MS, now - HOUR_MS);

  const replay = replayRule({
    rule, history, plannerConfig,
    firstDecisionDay: utcDateStr(HOLDOUT_START_MS), lastDecisionDay: utcDateStr(HOLDOUT_END_MS),
    cutoffMs, slippageBps: args.slippageBps,
  });
  const permutation = runPermutation({
    rule, history, plannerConfig, trades: replay.trades, eligibleDays: replay.eligibleDays,
    cutoffMs, slippageBps: args.slippageBps, runs: args.permutationRuns, seed: args.seed,
  });

  const report = runGateD0(replay.trades, permutation, {
    ruleId: rule.id, ruleHash: identity.ruleHash, rulesFileCommit, ruleSymbolCount: rule.symbols.length,
    ruleEvaluationIndex: rIdx, globalEvaluationIndex: gIdx, seed: args.seed, resamples: args.resamples,
    slippageBps: args.slippageBps, unfilledCount: replay.unfilled.length,
    symbols: symbolFirstKlineTimes(history, rule.symbols), historyCoverage: historyCoverageOf(history),
    command, now,
  });

  const path = writeArtifactNeverOverwrite(
    deps, args.artifactsDir, `gate-d0-${rule.id}-${utcDateStr(now)}`, `${JSON.stringify(report, null, 2)}\n`,
  );
  return { exitCode: report.verdict === "edge_confirmed" ? 0 : 1, artifactPath: path };
}

// ── d1-check mode ────────────────────────────────────────────────────────────────────────────

function loadD0Artifacts(dir: string, ruleId: string, deps: BacktestDeps): GateD0Report[] {
  if (!deps.fileExists(dir)) return [];
  const prefix = `gate-d0-${ruleId}-`;
  const artifacts: GateD0Report[] = [];
  for (const file of deps.listDir(dir)) {
    if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
    try {
      artifacts.push(JSON.parse(deps.readFile(join(dir, file))) as GateD0Report);
    } catch {
      // Best-effort: a malformed artifact is skipped, not fatal to d1-check (the ledger, not
      // these read-back artifacts, is the fail-closed boundary).
    }
  }
  return artifacts;
}

async function runD1Check(
  args: BacktestDailyArgs,
  deps: BacktestDeps,
  ruleSet: RuleSet,
): Promise<BacktestDailyResult> {
  const identity = resolveRuleIdentity(args.rule, ruleSet);
  if (identity === null) {
    return { exitCode: 1, message: `rule "${args.rule}" is not in research-rules.json` };
  }

  let journal: ManualTrade[];
  try {
    journal = loadManualJournal({ path: args.journalPath });
  } catch (err) {
    if (err instanceof JournalUnreadableError) {
      return { exitCode: 1, message: `manual journal is unreadable: ${err.message}` };
    }
    throw err;
  }

  const selected = selectPaperTradesForRule(
    journal, identity.ruleId, identity.ruleHash,
    identity.origin === "ai-analyst" || identity.origin === "persona" ? "prefix" : "exact",
  );
  const reviews: D1Review[] = selected.map((t) => ({ ...reviewClosedTrade(t, []), venue: t.venue }));

  const now = deps.now();
  const firstPaperEntryTime = selected.length > 0
    ? minOf(selected.map((t) => firstEntryTime(t)))
    : now;

  const d0Artifacts = identity.forwardOnly ? [] : loadD0Artifacts(args.artifactsDir, identity.ruleId, deps);
  const d0Artifact = selectD0HoldoutArtifact(d0Artifacts, identity.ruleHash);
  const d0Holdout = d0Artifact ? { r: d0Artifact.holdoutTradeR, days: d0Artifact.holdoutTradeDays } : null;

  const relevantSources = identity.rule ? ruleFeatureSourceIds(identity.rule) : new Set<SourceId>();
  const days = utcDaysInclusive(firstPaperEntryTime, now).map((d) => dayReportSummary(args.reportsRoot, d, deps));
  const docsPath = join(args.docsValidationDir, `d1-${identity.ruleId}.md`);
  const explainedDates = deps.fileExists(docsPath) ? parseExplainedDates(deps.readFile(docsPath)) : new Set<string>();
  const unexplained = unexplainedIncompleteDays(days, relevantSources, explainedDates);

  const command = `backtest:daily --rule ${identity.ruleId} --mode d1-check`;
  const report: GateD1Report = runGateD1(reviews, {
    ruleId: identity.ruleId, ruleHash: identity.ruleHash, forwardOnly: identity.forwardOnly,
    firstPaperEntryTime, now, d0Holdout, unexplainedIncompleteDays: unexplained,
    seed: args.seed, resamples: args.resamples, command,
  });

  const path = writeArtifactNeverOverwrite(
    deps, args.artifactsDir, `gate-d1-${identity.ruleId}-${utcDateStr(now)}`, `${JSON.stringify(report, null, 2)}\n`,
  );
  return { exitCode: report.verdict === "paper_passed" ? 0 : 1, artifactPath: path };
}

// ── orchestration ────────────────────────────────────────────────────────────────────────────

export async function runBacktestDaily(args: BacktestDailyArgs, deps: BacktestDeps): Promise<BacktestDailyResult> {
  const config = loadConfig(args.configPath);

  let ruleSetRaw: string;
  try {
    ruleSetRaw = deps.readFile(args.rulesPath);
  } catch (err) {
    return { exitCode: 1, message: `cannot read rules file at "${args.rulesPath}": ${(err as Error).message}` };
  }
  let ruleSet: RuleSet;
  try {
    ruleSet = parseRuleSet(JSON.parse(ruleSetRaw), config.symbols);
  } catch (err) {
    if (err instanceof RuleSetValidationError) {
      return { exitCode: 1, message: err.message };
    }
    throw err;
  }

  if (args.mode === "d1-check") return runD1Check(args, deps, ruleSet);

  const identity = resolveRuleIdentity(args.rule, ruleSet);
  if (identity === null || identity.rule === null) {
    // dev mode also needs a real rule (it simulates the rule itself); holdout re-derives
    // identity internally to apply its own ordered refusal messages.
    if (args.mode === "holdout") return runHoldout(args, deps, ruleSet, buildPlannerConfig(config));
    return { exitCode: 1, message: `rule "${args.rule}" is not in research-rules.json (or is a synthetic ai-analyst-* id, not valid for --mode dev)` };
  }

  const plannerConfig = buildPlannerConfig(config);
  if (args.mode === "dev") return runDev(args, deps, identity.rule, plannerConfig);
  return runHoldout(args, deps, ruleSet, plannerConfig);
}

async function main(): Promise<void> {
  const args = parseBacktestDailyArgs(process.argv.slice(2));
  const deps = defaultBacktestDeps();
  const result = await runBacktestDaily(args, deps);
  if (result.artifactPath) console.log(`artifact written: ${result.artifactPath} (exit ${result.exitCode})`);
  if (result.message) (result.exitCode === 0 ? console.log : console.error)(result.message);
  process.exitCode = result.exitCode;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
