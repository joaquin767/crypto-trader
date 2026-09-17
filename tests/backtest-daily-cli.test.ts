// backtest-daily.ts CLI tests — specs/daily-catalyst-manual-trading.md §5.12 `backtest:daily`,
// §5.10a "Windows and leakage" / "Ledger and multiple testing", AC-22, AC-86, AC-90, AC-93.
//
// git is stubbed via BacktestDeps (never shells out); config/rules/history/ledger/artifacts all
// live under a fresh mkdtemp() directory per test so nothing here ever touches the repo's real
// research-rules.json or data/validation/daily/holdout-ledger.jsonl.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findHoldoutLeak, parseBacktestDailyArgs, runBacktestDaily } from "../scripts/backtest-daily.ts";
import type { BacktestDailyArgs, BacktestDeps } from "../scripts/backtest-daily.ts";
import { saveHistoryFile } from "../src/backtest-daily/history-store.ts";
import type { HistoryFile } from "../src/backtest-daily/history-store.ts";
import { HOLDOUT_START_MS } from "../src/backtest-daily/gate-d0.ts";
import type { SimTrade } from "../src/backtest-daily/simulate.ts";
import type { SourceRow } from "../src/research/types.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = HOLDOUT_START_MS + 400 * DAY; // safely after the whole holdout window

function trade(overrides: Partial<SimTrade> = {}): SimTrade {
  return {
    planId: "p", ruleId: "r", symbol: "BTC/USDT", decisionDay: "2026-01-01",
    entryTime: 0, exitTime: 0, entryPrice: 100, exitPrice: 100, exitKind: "time",
    netPnlUsd: 0, riskUsd: 1, rMultiple: 0, fundingUsd: 0, feesUsd: 0,
    ...overrides,
  };
}

// ── findHoldoutLeak (AC-22) ──────────────────────────────────────────────────────────────────

test("AC-22: findHoldoutLeak flags a sim trade whose entryTime reaches the holdout", () => {
  const trades = [trade({ entryTime: HOLDOUT_START_MS - 1 }), trade({ entryTime: HOLDOUT_START_MS })];
  const leak = findHoldoutLeak(trades, HOLDOUT_START_MS);
  assert.equal(leak?.entryTime, HOLDOUT_START_MS);
});

test("AC-22: findHoldoutLeak returns null when every trade stays before the holdout", () => {
  const trades = [trade({ entryTime: HOLDOUT_START_MS - 1 })];
  assert.equal(findHoldoutLeak(trades, HOLDOUT_START_MS), null);
});

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const RULE_ID = "test-rule";
const SYMBOL = "BTC/USDT";

function validRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID, version: 1, description: "d", evidence: ["X1"], status: "experimental",
    symbols: [SYMBOL], side: "long",
    entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
    stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 1, forwardOnly: false, origin: "rules-file",
    ...overrides,
  };
}

function writeRulesFile(dir: string, rules: Record<string, unknown>[]): string {
  const path = join(dir, "research-rules.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, rules }));
  return path;
}

function writeConfig(dir: string): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    exchange: "bybit", apiKey: "k", apiSecret: "s", symbols: [SYMBOL],
    maxCapitalUsd: 100, maxPositionSizeUsd: 25, maxDailyTrades: 10,
    stopLossPercent: 5, takeProfitPercent: 10, refreshIntervalMs: 3000,
  }));
  return path;
}

/** Deterministic, always-fillable history: flat daily/hourly price so `close`/`atr14d` are
 *  always present and no bar ever gaps or touches stop/target (clean time exits), plus zero
 *  funding and permissive instrument filters — from `fromMs` through `toMs`. */
function writeFullHistory(dir: string, fromMs: number, toMs: number): void {
  const dailyRows: SourceRow[] = [];
  for (let t = fromMs - 60 * DAY; t <= toMs; t += DAY) {
    const availableAt = t + DAY;
    dailyRows.push(
      { key: SYMBOL, observedFor: t, availableAt, field: "open", value: 60000 },
      { key: SYMBOL, observedFor: t, availableAt, field: "high", value: 60500 },
      { key: SYMBOL, observedFor: t, availableAt, field: "low", value: 59500 },
      { key: SYMBOL, observedFor: t, availableAt, field: "close", value: 60000 },
      { key: SYMBOL, observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  }
  const hourlyRows: SourceRow[] = [];
  for (let t = fromMs; t <= toMs; t += HOUR) {
    const availableAt = t + HOUR;
    hourlyRows.push(
      { key: SYMBOL, observedFor: t, availableAt, field: "open", value: 60000 },
      { key: SYMBOL, observedFor: t, availableAt, field: "high", value: 60000 },
      { key: SYMBOL, observedFor: t, availableAt, field: "low", value: 60000 },
      { key: SYMBOL, observedFor: t, availableAt, field: "close", value: 60000 },
      { key: SYMBOL, observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  }
  const fundingRows: SourceRow[] = [];
  for (let t = fromMs - DAY; t <= toMs + DAY; t += 8 * HOUR) {
    fundingRows.push({ key: SYMBOL, observedFor: t, availableAt: t, field: "fundingRate", value: 0 });
  }
  const instrumentRows: SourceRow[] = [
    { key: SYMBOL, observedFor: 0, availableAt: 0, field: "minOrderQty", value: 0.0001 },
    { key: SYMBOL, observedFor: 0, availableAt: 0, field: "qtyStep", value: 0.0001 },
    { key: SYMBOL, observedFor: 0, availableAt: 0, field: "minNotionalValue", value: 5 },
  ];

  const files: HistoryFile[] = [
    { sourceId: "bybit-klines-1d", builtAt: 0, coverage: { from: fromMs - 60 * DAY, to: toMs }, rows: dailyRows },
    { sourceId: "bybit-klines-1h", builtAt: 0, coverage: { from: fromMs, to: toMs }, rows: hourlyRows },
    { sourceId: "bybit-funding", builtAt: 0, coverage: { from: fromMs - DAY, to: toMs + DAY }, rows: fundingRows },
    { sourceId: "bybit-instruments", builtAt: 0, coverage: { from: 0, to: 0 }, rows: instrumentRows },
  ];
  for (const f of files) saveHistoryFile(dir, f);
}

function fakeDeps(dir: string, overrides: Partial<BacktestDeps> = {}): BacktestDeps {
  return {
    now: () => NOW,
    readFile: (p) => readFileSync(p, "utf-8"),
    fileExists: (p) => existsSync(p),
    writeFile: (p, content) => writeFileSync(p, content),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    listDir: (p) => (existsSync(p) ? readdirSync(p) : []),
    gitRulesFileDirty: () => false,
    gitRulesFileCommit: () => "abc123def456",
    ...overrides,
  };
}

function makeArgs(dir: string, overrides: Partial<BacktestDailyArgs> = {}): BacktestDailyArgs {
  return {
    rule: RULE_ID,
    mode: "holdout",
    configPath: writeConfig(dir),
    rulesPath: join(dir, "research-rules.json"),
    historyDir: join(dir, "history"),
    reportsRoot: join(dir, "reports"),
    journalPath: join(dir, "manual-journal.json"),
    artifactsDir: join(dir, "artifacts"),
    ledgerPath: join(dir, "artifacts", "holdout-ledger.jsonl"),
    docsValidationDir: join(dir, "docs-validation"),
    seed: 20260917,
    slippageBps: 5,
    resamples: 200,
    permutationRuns: 30, // small on purpose — these tests check refusal/ledger/artifact shape, not the verdict
    ...overrides,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "backtest-daily-cli-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── AC-86 ────────────────────────────────────────────────────────────────────────────────────

test("AC-86: holdout mode for a forwardOnly rule exits 1 and appends no ledger line", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule({ forwardOnly: true })]);
    const args = makeArgs(dir);
    const result = await runBacktestDaily(args, fakeDeps(dir));
    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(args.ledgerPath), false);
  });
});

test("AC-86: holdout mode for an ai-analyst-* id exits 1 and appends no ledger line", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule()]);
    const args = makeArgs(dir, { rule: "ai-analyst-abcd1234" });
    const result = await runBacktestDaily(args, fakeDeps(dir));
    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(args.ledgerPath), false);
  });
});

test("AC-86: for an eligible rule, the ledger line exists even if simulation then throws", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule()]);
    // A malformed history file makes loadHistory() throw AFTER the ledger append (runHoldout
    // appends the ledger line, then loads history, then replays/simulates).
    mkdirSync(join(dir, "history"), { recursive: true });
    writeFileSync(join(dir, "history", "bybit-klines-1h.json"), JSON.stringify({ notAHistoryFile: true }));
    const args = makeArgs(dir);
    await assert.rejects(() => runBacktestDaily(args, fakeDeps(dir)));
    assert.equal(existsSync(args.ledgerPath), true);
    const lines = readFileSync(args.ledgerPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).ruleId, RULE_ID);
  });
});

// ── AC-93 ────────────────────────────────────────────────────────────────────────────────────

test("AC-93: refuses when research-rules.json has uncommitted changes (ledger unchanged)", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule()]);
    const args = makeArgs(dir);
    const result = await runBacktestDaily(args, fakeDeps(dir, { gitRulesFileDirty: () => true }));
    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(args.ledgerPath), false);
  });
});

test("AC-93: refuses when git is unavailable (ledger unchanged)", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule()]);
    const args = makeArgs(dir);
    const result = await runBacktestDaily(args, fakeDeps(dir, { gitRulesFileDirty: () => null }));
    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(args.ledgerPath), false);
  });
});

test("AC-93: refuses when the ledger has an entry with a different holdoutStart (ledger unchanged)", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule()]);
    const args = makeArgs(dir);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const staleEntry = {
      time: 1, ruleId: RULE_ID, ruleHash: "h", rulesFileCommit: "c", command: "cmd",
      holdoutStart: HOLDOUT_START_MS - DAY, holdoutEnd: HOLDOUT_START_MS + 100 * DAY, seed: 1, slippageBps: 5,
    };
    writeFileSync(args.ledgerPath, `${JSON.stringify(staleEntry)}\n`);
    const before = readFileSync(args.ledgerPath, "utf-8");

    const result = await runBacktestDaily(args, fakeDeps(dir));
    assert.equal(result.exitCode, 1);
    assert.equal(readFileSync(args.ledgerPath, "utf-8"), before, "ledger must be unchanged after a window-mismatch refusal");
  });
});

test("AC-93: refuses when the ledger has an unparseable line (ledger unchanged)", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule()]);
    const args = makeArgs(dir);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(args.ledgerPath, "not json at all\n");
    const before = readFileSync(args.ledgerPath, "utf-8");

    const result = await runBacktestDaily(args, fakeDeps(dir));
    assert.equal(result.exitCode, 1);
    assert.equal(readFileSync(args.ledgerPath, "utf-8"), before, "ledger must be unchanged after an unparseable-line refusal");
  });
});

// ── AC-90 ────────────────────────────────────────────────────────────────────────────────────

test("AC-90: the gate-d0 artifact carries holdoutTradeR/holdoutTradeDays/symbols/slippageBps/seed/permutationRunsCompleted/historyCoverage", async () => {
  await withTempDir(async (dir) => {
    writeRulesFile(dir, [validRule()]);
    writeFullHistory(join(dir, "history"), HOLDOUT_START_MS, HOLDOUT_START_MS + 100 * DAY);
    const args = makeArgs(dir);
    const result = await runBacktestDaily(args, fakeDeps(dir));

    assert.ok(result.artifactPath, "expected an artifact to be written");
    const report = JSON.parse(readFileSync(result.artifactPath!, "utf-8"));

    assert.equal(report.holdoutTradeR.length, report.closedTrades);
    assert.equal(report.holdoutTradeDays.length, report.closedTrades);
    assert.ok(Array.isArray(report.symbols) && report.symbols.length === 1);
    assert.equal(report.symbols[0].symbol, SYMBOL);
    assert.equal(typeof report.symbols[0].firstKlineTime, "number");
    assert.equal(report.slippageBps, args.slippageBps);
    assert.equal(report.seed, args.seed);
    assert.equal(typeof report.permutationRunsCompleted, "number");
    for (const sourceId of ["bybit-klines-1d", "bybit-klines-1h", "bybit-funding", "bybit-instruments"]) {
      assert.ok(report.historyCoverage[sourceId], `missing historyCoverage for ${sourceId}`);
      assert.equal(typeof report.historyCoverage[sourceId].rows, "number");
    }
  });
});

// ── args parsing ─────────────────────────────────────────────────────────────────────────────

test("parseBacktestDailyArgs: defaults and flags", () => {
  const args = parseBacktestDailyArgs(["--rule", "my-rule", "--mode", "dev"]);
  assert.equal(args.rule, "my-rule");
  assert.equal(args.mode, "dev");
  assert.equal(args.historyDir, "data/history");
  assert.equal(args.reportsRoot, "reports");
  assert.equal(args.journalPath, "./manual-journal.json");
  assert.equal(args.seed, 20260917);
  assert.equal(args.slippageBps, 5);

  const withFlags = parseBacktestDailyArgs([
    "--rule", "my-rule", "--mode", "dev", "--history-dir", "/tmp/h", "--reports-root", "/tmp/r",
    "--journal-path", "/tmp/j.json", "--seed", "42", "--slippage-bps", "10",
  ]);
  assert.equal(withFlags.historyDir, "/tmp/h");
  assert.equal(withFlags.reportsRoot, "/tmp/r");
  assert.equal(withFlags.journalPath, "/tmp/j.json");
  assert.equal(withFlags.seed, 42);
  assert.equal(withFlags.slippageBps, 10);
});

test("parseBacktestDailyArgs: throws without --rule/--mode", () => {
  assert.throws(() => parseBacktestDailyArgs(["--rule", "x"]));
  assert.throws(() => parseBacktestDailyArgs(["--mode", "dev"]));
  assert.throws(() => parseBacktestDailyArgs(["--rule", "x", "--mode", "bogus"]));
});

// ── Gate-mode flag locks (verifier P0s) ─────────────────────────────────────────────────────────

test("gate modes reject every flag that could move the ledger, rules file, data or statistics", () => {
  for (const mode of ["holdout", "d1-check"]) {
    for (const flag of ["--rules-path", "--history-dir", "--reports-root", "--journal-path", "--artifacts-dir", "--ledger-path", "--docs-validation-dir", "--seed", "--resamples", "--permutation-runs"]) {
      assert.throws(() => parseBacktestDailyArgs(["--rule", "r", "--mode", mode, flag, "x"]), /only allowed with --mode dev/, `${mode} ${flag}`);
    }
  }
  // dev mode keeps them for experiments
  assert.doesNotThrow(() => parseBacktestDailyArgs(["--rule", "r", "--mode", "dev", "--ledger-path", "/tmp/l.jsonl", "--rules-path", "/tmp/r.json"]));
});

test("gate modes only accept --slippage-bps >= 5", () => {
  assert.throws(() => parseBacktestDailyArgs(["--rule", "r", "--mode", "holdout", "--slippage-bps", "2"]), />= 5/);
  assert.doesNotThrow(() => parseBacktestDailyArgs(["--rule", "r", "--mode", "holdout", "--slippage-bps", "10"]));
});
