// claude-cli-client.ts tests — specs/daily-catalyst-manual-trading.md §5.13, §4.17.
// No real `claude` process is ever spawned: `deps.spawn` is replaced by a fake that emits
// recorded/synthetic stdout, so these tests exercise the whole event-parsing and error-mapping
// path deterministically. Test (1) replays the real recorded stream at
// tests/fixtures/research/claude-cli-stream.jsonl verbatim EXCEPT for the terminal event's
// `structured_output`/`result` fields: the recorded session answered an unrelated one-field
// "find this URL" prompt (`{"url": "..."}"), which does not match this project's
// `aiAnalystOutputSchema` (regimeSummary/planAssessments/ideas/...) — everything else about that
// event (modelUsage, total_cost_usd, is_error, subtype) plus every earlier line (the WebSearch
// tool call and its 10-URL result) is used exactly as recorded, so the usage/cost/webResults
// arithmetic below is computed from the real fixture, not invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildProcessLike, ClaudeCliClientDeps } from "../src/research/ai/claude-cli-client.ts";
import { createClaudeCliAiClient } from "../src/research/ai/claude-cli-client.ts";
import type { AiAnalystConfig, AiAnalystInput } from "../src/research/ai/types.ts";
import { AI_OUTPUT_JSON_SCHEMA } from "../src/research/ai/output-schema.ts";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "research", "claude-cli-stream.jsonl");

const VALID_OUTPUT = {
  regimeSummary: "calm", planAssessments: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [],
};

function aiCfg(overrides: Partial<AiAnalystConfig> = {}): AiAnalystConfig {
  return {
    enabled: true, provider: "claude-cli", cliPath: "claude", model: "claude-opus-5", effort: "high", maxTokens: 32_000,
    webSearchMaxUses: 5, maxIdeasPerDay: 3, monthlyBudgetUsd: 15, inputUsdPerMTok: 5, outputUsdPerMTok: 25,
    webSearchUsdPerRequest: 0.01, channelStatus: "experimental", passedPromptHash: null, timeoutMs: 600_000,
    ...overrides,
  };
}

function aiInput(overrides: Partial<AiAnalystInput> = {}): AiAnalystInput {
  return {
    dateUtc: "2026-09-16", decisionTime: 0, promptVersionHash: "hash", systemPrompt: "sp",
    sources: [], features: [], outcomes: [], rulePlans: [], openTrades: [], configSymbols: ["BTC/USDT"],
    ...overrides,
  };
}

/** Patches only the terminal `result` event's `structured_output`/`result` fields to a
 *  schema-valid `AiAnalystOutput` — every other line (and every other field of that same event:
 *  modelUsage, total_cost_usd, is_error, subtype) is preserved verbatim from the recording. */
function loadFixtureWithValidStructuredOutput(): string {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const lines = raw.split("\n").map((line) => {
    if (line.trim().length === 0) return line;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event["type"] === "result") {
      event["structured_output"] = VALID_OUTPUT;
      event["result"] = JSON.stringify(VALID_OUTPUT);
    }
    return JSON.stringify(event);
  });
  return lines.join("\n");
}

interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  closeCode?: number | null;
  errorInstead?: Error;
  neverClose?: boolean;
}

interface FakeChildHandle {
  child: ChildProcessLike;
  stdinChunks: string[];
  killed(): boolean;
}

/** Emits its canned stdout/stderr and a close (or error, or nothing) on the next microtask —
 *  close enough to a real child process's async event timing for these tests. */
function fakeChild(opts: FakeChildOptions): FakeChildHandle {
  const emitter = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinChunks: string[] = [];
  let killed = false;

  const child: ChildProcessLike = {
    stdin: { write: (chunk: string) => { stdinChunks.push(chunk); }, end: () => {} },
    stdout: { on: (event, listener) => { stdoutEmitter.on(event, listener); } },
    stderr: { on: (event, listener) => { stderrEmitter.on(event, listener); } },
    on: (event, listener) => { emitter.on(event, listener as (...args: unknown[]) => void); },
    kill: () => { killed = true; },
  };

  queueMicrotask(() => {
    if (opts.errorInstead) {
      emitter.emit("error", opts.errorInstead);
      return;
    }
    if (opts.stdout) stdoutEmitter.emit("data", opts.stdout);
    if (opts.stderr) stderrEmitter.emit("data", opts.stderr);
    if (!opts.neverClose) emitter.emit("close", opts.closeCode ?? 0);
  });

  return { child, stdinChunks, killed: () => killed };
}

function resultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: VALID_OUTPUT,
    result: JSON.stringify(VALID_OUTPUT),
    total_cost_usd: 0.01,
    modelUsage: {
      "claude-opus-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 },
    },
    ...overrides,
  });
}

function makeDeps(handle: FakeChildHandle): { deps: ClaudeCliClientDeps; capturedArgs: string[][]; capturedEnv: NodeJS.ProcessEnv[] } {
  const capturedArgs: string[][] = [];
  const capturedEnv: NodeJS.ProcessEnv[] = [];
  return {
    deps: {
      spawn: (_command, args, options) => {
        capturedArgs.push(args);
        capturedEnv.push(options.env);
        return handle.child;
      },
    },
    capturedArgs,
    capturedEnv,
  };
}

// `fn` is always async here (it wraps a `withTempDir` call) — `await`ing it before restoring env
// vars is required: returning the pending promise without awaiting would let `finally` restore
// the env immediately (synchronously), while the callback's own later `await`s (e.g. a second
// `port.analyze(...)` call after the first one resolves) are still pending and would then run
// under the WRONG (already-restored) environment.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-claude-cli-test-"));
  return (async () => {
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

// ── (1) replay the real fixture -> ok ───────────────────────────────────────────────────────

test("ok: replays the recorded fixture, parses structured_output, extracts webResults, sums modelUsage, writes the raw file once", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token", ANTHROPIC_API_KEY: undefined }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: loadFixtureWithValidStructuredOutput() });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());

    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.deepEqual(result.output, VALID_OUTPUT);
    assert.equal(result.webResults.length, 10);
    assert.equal(result.webResults[0]!.url, "https://farside.co.uk/btc/");
    assert.equal(result.webResults[0]!.pageAge, null);
    // 4+19830+1893 (claude-sonnet-5) + 8926+0+0 (claude-haiku-4-5-20251001) = 30653
    assert.deepEqual(result.usage, { inputTokens: 30653, outputTokens: 579, webSearchRequests: 1 });
    assert.equal(result.servedByModel, "claude-sonnet-5,claude-haiku-4-5-20251001");
    assert.ok(result.listCostUsd !== undefined && Math.abs(result.listCostUsd - 0.034642) < 1e-9);
    assert.ok(existsSync(result.rawResponsePath));

    // A second call for the same dateUtc/snapshotRoot must not overwrite the raw file.
    const before = readFileSync(result.rawResponsePath, "utf-8");
    const handle2 = fakeChild({ stdout: `${resultLine({ total_cost_usd: 99 })}\n` });
    const { deps: deps2 } = makeDeps(handle2);
    const port2 = createClaudeCliAiClient(aiCfg(), dir, deps2);
    const result2 = await port2.analyze(aiInput());
    assert.equal(result2.kind, "ok");
    assert.equal(readFileSync(result.rawResponsePath, "utf-8"), before);
  }));
});

// ── (2) args and env ─────────────────────────────────────────────────────────────────────────

test("args: includes --json-schema/model/effort, WebSearch tools when enabled, never --bare; env drops ANTHROPIC_API_KEY when OAuth token is set", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token", ANTHROPIC_API_KEY: "sk-should-be-removed" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine()}\n` });
    const { deps, capturedArgs, capturedEnv } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg({ webSearchMaxUses: 5, model: "claude-opus-5", effort: "xhigh" }), dir, deps);
    await port.analyze(aiInput({ systemPrompt: "be careful" }));

    const args = capturedArgs[0]!;
    assert.ok(args.includes("--json-schema"));
    assert.equal(args[args.indexOf("--json-schema") + 1], AI_OUTPUT_JSON_SCHEMA);
    assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "claude-opus-5");
    assert.ok(args.includes("--effort") && args[args.indexOf("--effort") + 1] === "xhigh");
    assert.ok(args.includes("--system-prompt") && args[args.indexOf("--system-prompt") + 1] === "be careful");
    assert.ok(args.includes("--allowedTools") && args[args.indexOf("--allowedTools") + 1] === "WebSearch");
    assert.ok(args.includes("--tools") && args[args.indexOf("--tools") + 1] === "WebSearch");
    assert.ok(!args.includes("--bare"));

    assert.equal(capturedEnv[0]!["ANTHROPIC_API_KEY"], undefined);
  }));
});

test("args: --tools \"\" (and no --allowedTools) when webSearchMaxUses is 0", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine()}\n` });
    const { deps, capturedArgs } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg({ webSearchMaxUses: 0 }), dir, deps);
    await port.analyze(aiInput());

    const args = capturedArgs[0]!;
    assert.ok(args.includes("--tools") && args[args.indexOf("--tools") + 1] === "");
    assert.ok(!args.includes("--allowedTools"));
    assert.ok(!args.includes("--bare"));
  }));
});

// ── (3) subtype-specific mappings ────────────────────────────────────────────────────────────

test("error_max_structured_output_retries -> schema_invalid", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine({ subtype: "error_max_structured_output_retries", is_error: true, structured_output: undefined })}\n` });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "schema_invalid");
  }));
});

test("error_max_turns -> max_tokens", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine({ subtype: "error_max_turns", is_error: true, structured_output: undefined })}\n` });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "max_tokens");
  }));
});

test("is_error true with 401 text -> api_error naming CLAUDE_CODE_OAUTH_TOKEN", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine({ subtype: "error", is_error: true, structured_output: undefined, result: "401 unauthorized" })}\n` });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "api_error");
    assert.match(result.detail, /CLAUDE_CODE_OAUTH_TOKEN/);
  }));
});

test("is_error true with 429/rate limit text -> rate_limited", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine({ subtype: "error", is_error: true, structured_output: undefined, result: "429 rate limit exceeded" })}\n` });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "rate_limited");
  }));
});

test("is_error true with refusal text -> refusal", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine({ subtype: "error", is_error: true, structured_output: undefined, result: "I must refuse this request" })}\n` });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "refusal");
  }));
});

// ── (4) structured_output failing zod ────────────────────────────────────────────────────────

test("structured_output that fails the zod schema -> schema_invalid", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ stdout: `${resultLine({ structured_output: { nope: true } })}\n` });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "schema_invalid");
  }));
});

// ── (5) timeout kills the child ──────────────────────────────────────────────────────────────

test("timeout: kills the child and resolves failed timeout", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ neverClose: true });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg({ timeoutMs: 20 }), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "timeout");
    assert.equal(handle.killed(), true);
  }));
});

// ── (6) spawn error ──────────────────────────────────────────────────────────────────────────

test("a spawn ENOENT error resolves failed api_error, never rejects", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const handle = fakeChild({ errorInstead: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "api_error");
    assert.match(result.detail, /claude/);
  }));
});

// ── (7) no credentials ───────────────────────────────────────────────────────────────────────

test("no CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY -> no_api_key, spawn never called", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined }, () => withTempDir(async (dir) => {
    let called = false;
    const deps: ClaudeCliClientDeps = { spawn: () => { called = true; throw new Error("must not be called"); } };
    const port = createClaudeCliAiClient(aiCfg(), dir, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "no_api_key");
    assert.equal(called, false);
  }));
});

// ── (8) unwritable snapshotRoot ──────────────────────────────────────────────────────────────

test("an unwritable snapshotRoot (a path under a regular file) resolves failed api_error, never rejects", async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, () => withTempDir(async (dir) => {
    const regularFile = join(dir, "not-a-directory");
    writeFileSync(regularFile, "x");
    const snapshotRoot = join(regularFile, "sub");
    const handle = fakeChild({ stdout: `${resultLine()}\n` });
    const { deps } = makeDeps(handle);
    const port = createClaudeCliAiClient(aiCfg(), snapshotRoot, deps);
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "api_error");
  }));
});
