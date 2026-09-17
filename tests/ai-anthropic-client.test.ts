// anthropic-client.ts tests — specs/daily-catalyst-manual-trading.md §5.13, §4.17.
// No network call: `deps.makeClient` substitutes a fake `{ beta: { messages: { stream } } }`
// shaped exactly like the real SDK's return type as far as this module reads it. Importing
// `APIError` from `@anthropic-ai/sdk` here is fine — gate §12.10 only restricts src/ and
// scripts/ to the one client/schema file pair.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APIError } from "@anthropic-ai/sdk";

import type { AnthropicClientDeps } from "../src/research/ai/anthropic-client.ts";
import { createAnthropicAiClient } from "../src/research/ai/anthropic-client.ts";
import type { AiAnalystConfig, AiAnalystInput } from "../src/research/ai/types.ts";

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
    sources: [], features: [], outcomes: [], rulePlans: [], openTrades: [], configSymbols: ["BTC/USDT"],
    ...overrides,
  };
}

const VALID_OUTPUT = {
  regimeSummary: "calm", planAssessments: [], ideas: [], openTradeNotes: [], risks: [], dataGaps: [],
};

type StreamCall = { params: Record<string, unknown>; opts: unknown };

/** A fake client whose `stream(...).finalMessage()` resolves/rejects from `responses` in order,
 *  one per call — recording every call's params/opts for assertions. */
function fakeMakeClient(responses: Array<() => Promise<unknown>>): { makeClient: () => AnthropicClientDeps["makeClient"] extends undefined ? never : ReturnType<NonNullable<AnthropicClientDeps["makeClient"]>>; calls: StreamCall[] } {
  const calls: StreamCall[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream: (params: unknown, opts?: unknown) => {
          calls.push({ params: params as Record<string, unknown>, opts });
          const index = i++;
          return {
            finalMessage: () => {
              const respond = responses[index];
              if (!respond) throw new Error(`fakeMakeClient: no response configured for call #${index}`);
              return respond();
            },
          };
        },
      },
    },
  };
  return { makeClient: () => client, calls };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-opus-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 0 } },
    content: [{ type: "text", text: JSON.stringify(VALID_OUTPUT) }],
    ...overrides,
  };
}

// Both helpers `await` their (async) callback before cleanup — returning the callback's promise
// without awaiting it would let `finally` run the cleanup (restoring the env var / deleting the
// temp dir) while the callback's own `await`s are still pending, corrupting later assertions.
async function withEnvKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "test";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = saved;
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-anthropic-client-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── ok response ──────────────────────────────────────────────────────────────────────────────

test("ok: parses output, extracts webResults and usage, writes the raw file once (not overwritten)", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const first = fakeMakeClient([async () => message({
      content: [
        { type: "text", text: JSON.stringify(VALID_OUTPUT) },
        { type: "web_search_tool_result", content: [{ url: "https://example.com/a", title: "A", page_age: "1 day" }] },
      ],
      usage: { input_tokens: 200, output_tokens: 80, server_tool_use: { web_search_requests: 2 } },
    })]);
    const port1 = createAnthropicAiClient(aiCfg(), dir, { makeClient: first.makeClient });
    const result1 = await port1.analyze(aiInput());
    assert.equal(result1.kind, "ok");
    if (result1.kind !== "ok") return;
    assert.deepEqual(result1.output, VALID_OUTPUT);
    assert.deepEqual(result1.webResults, [{ url: "https://example.com/a", title: "A", pageAge: "1 day" }]);
    assert.deepEqual(result1.usage, { inputTokens: 200, outputTokens: 80, webSearchRequests: 2 });
    assert.equal(result1.servedByModel, "claude-opus-5");
    assert.ok(existsSync(result1.rawResponsePath));
    const firstRaw = readFileSync(result1.rawResponsePath, "utf-8");

    // A second call for the same dateUtc/snapshotRoot must not overwrite the raw file.
    const second = fakeMakeClient([async () => message({ model: "some-other-model" })]);
    const port2 = createAnthropicAiClient(aiCfg(), dir, { makeClient: second.makeClient });
    const result2 = await port2.analyze(aiInput());
    assert.equal(result2.kind, "ok");
    assert.equal(result2.rawResponsePath, result1.rawResponsePath);
    assert.equal(readFileSync(result1.rawResponsePath, "utf-8"), firstRaw);
  }));
});

// ── refusal / max_tokens / schema_invalid ────────────────────────────────────────────────────

test("refusal: stop_reason 'refusal' -> failed refusal with usage", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([async () => message({ stop_reason: "refusal" })]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "refusal");
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50, webSearchRequests: 0 });
  }));
});

test("max_tokens: stop_reason 'max_tokens' -> failed max_tokens", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([async () => message({ stop_reason: "max_tokens" })]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "max_tokens");
  }));
});

test("schema_invalid: text that is not JSON", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([async () => message({ content: [{ type: "text", text: "not json at all" }] })]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "schema_invalid");
  }));
});

test("schema_invalid: JSON that fails the zod schema", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([async () => message({ content: [{ type: "text", text: JSON.stringify({ nope: true }) }] })]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "schema_invalid");
  }));
});

// ── fallback retry on a 400 (A17) ────────────────────────────────────────────────────────────

test("A17: a 400 on the first call retries once without fallbacks/the fallback beta; success on retry", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([
      async () => { throw new APIError(400, {}, "Bad Request", undefined); },
      async () => message(),
    ]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "ok");
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0]!.params["fallbacks"], "default");
    assert.ok((fake.calls[0]!.params["betas"] as string[]).includes("server-side-fallback-2026-07-01"));
    assert.equal(fake.calls[1]!.params["fallbacks"], undefined);
    assert.ok(!(fake.calls[1]!.params["betas"] as string[]).includes("server-side-fallback-2026-07-01"));
  }));
});

test("A17: a second failure after the 400 retry maps to api_error", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([
      async () => { throw new APIError(400, {}, "Bad Request", undefined); },
      async () => { throw new APIError(500, {}, "Internal Error", undefined); },
    ]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "api_error");
    assert.equal(fake.calls.length, 2);
  }));
});

// ── error mapping ────────────────────────────────────────────────────────────────────────────

test("429 -> rate_limited", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([async () => { throw new APIError(429, {}, "Rate limited", undefined); }]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "rate_limited");
  }));
});

test("a thrown error whose message contains 'timed out' -> timeout", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const fake = fakeMakeClient([async () => { throw new Error("Request timed out after 600000ms"); }]);
    const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "timeout");
  }));
});

// ── P0: never rejects even when the raw-file write fails ───────────────────────────────────

test("an unwritable snapshotRoot (a path under a regular file) resolves with failed api_error, never rejects", async () => {
  await withEnvKey(() => withTempDir(async (dir) => {
    const regularFile = join(dir, "not-a-directory");
    writeFileSync(regularFile, "x");
    const snapshotRoot = join(regularFile, "sub"); // mkdirSync under a file throws ENOTDIR
    const fake = fakeMakeClient([async () => message()]);
    const port = createAnthropicAiClient(aiCfg(), snapshotRoot, { makeClient: fake.makeClient });
    const result = await port.analyze(aiInput());
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.reason, "api_error");
  }));
});

// ── unrelated: unreachable without a key ─────────────────────────────────────────────────────

test("no key set -> no_api_key without ever calling makeClient", async () => {
  await withTempDir(async (dir) => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    const savedToken = process.env["ANTHROPIC_AUTH_TOKEN"];
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_AUTH_TOKEN"];
    try {
      let called = false;
      const port = createAnthropicAiClient(aiCfg(), dir, { makeClient: () => { called = true; throw new Error("must not be called"); } });
      const result = await port.analyze(aiInput());
      assert.equal(result.kind, "failed");
      if (result.kind !== "failed") return;
      assert.equal(result.reason, "no_api_key");
      assert.equal(called, false);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
      if (savedToken !== undefined) process.env["ANTHROPIC_AUTH_TOKEN"] = savedToken;
    }
  });
});
