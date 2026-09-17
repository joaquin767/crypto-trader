// Claude Code CLI AI client — specs/daily-catalyst-manual-trading.md §5.13, §4.17, §10.1, §10.2.
//
// Default provider (§5.11 AiAnalystConfig.provider): runs the analysis through the locally
// installed `claude` CLI under the owner's Claude Code subscription instead of paying per call
// via the Anthropic API — `src/research/ai/anthropic-client.ts` is kept as the alternative
// ("anthropic-api"). Implements `AiClientPort`, which MUST resolve, never reject (§5.13), with
// the same two-stage discipline as the SDK adapter:
//  1. Spawning the child and collecting its stdout/stderr/exit (or a timeout) — any failure here
//     (ENOENT, a killed timeout, an unexpected throw) resolves a `failed` result.
//  2. Everything done WITH the child's output — `writeRawResponseOnce` (shared with
//     anthropic-client.ts, ./raw-response.ts) plus parsing the JSONL event stream — is wrapped in
//     its own try/catch, so a write failure (e.g. an unwritable `snapshotRoot`) or a parsing bug
//     resolves `{kind:"failed", reason:"api_error", ...}` instead of throwing.
//
// Verified against `claude` CLI 2.1.274 on this machine; a real recorded stream is at
// tests/fixtures/research/claude-cli-stream.jsonl (one WebSearch call, one StructuredOutput
// call) — tests/ai-claude-cli-client.test.ts replays it through a fake `deps.spawn`, no real
// process is ever started by a test.
//
// CLI invocation (`-p` = headless "print" mode, one turn in, one result out):
//   -p --output-format stream-json --verbose --no-session-persistence --setting-sources ""
//   --permission-mode dontAsk --max-turns <2 + 2*webSearchMaxUses> --model <cfg.model>
//   --effort <cfg.effort> --json-schema <AI_OUTPUT_JSON_SCHEMA> --system-prompt <systemPrompt>
//   [--tools WebSearch --allowedTools WebSearch | --tools ""]
// `--json-schema`/`--system-prompt` go through the args array (no shell, no string interpolation
// into a command line) — same reasoning as never passing `--bare`, which the brief for this
// change calls out explicitly: `--bare` ignores the OAuth token, defeating the whole point of
// running under the subscription.
//
// Output-format `stream-json` prints one JSON object per line (JSONL): `system`/`assistant`/
// `user`/`rate_limit_event` events during the turn, then exactly one terminal `result` event
// (though NOT necessarily the last line overall — trailing `system` events like `task_summary`
// can follow it, per the recorded fixture). Web search results arrive on `user` events whose
// `tool_use_result` is an object carrying `results[]`; each `results[N].content[]` entry is
// `{title, url}` (the same information also appears as a "Links: [...]" string inside
// `message.content[].content`, which is NOT parsed — the object form is authoritative, per this
// change's brief). Usage is read from the terminal event's `modelUsage` map (one entry per model
// actually used, e.g. a cheaper model routed to the web-search sub-task) rather than its
// top-level `usage.server_tool_use.web_search_requests`, which the brief notes stays 0 even when
// a search happened.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AI_OUTPUT_JSON_SCHEMA, aiAnalystOutputSchema } from "./output-schema.ts";
import { writeRawResponseOnce } from "./raw-response.ts";
import type { AiAnalystConfig, AiAnalystInput, AiAnalystOutput, AiCallResult, AiClientPort } from "./types.ts";

/** The minimal shape this module actually calls on a spawned child — deliberately looser than
 *  Node's `ChildProcess` so a test can substitute a fake without implementing the whole class. */
export interface ChildProcessLike {
  stdin: { write(chunk: string): void; end(): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(): void;
}

export interface ClaudeCliClientDeps {
  spawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessLike;
}

function hasCredential(): boolean {
  return Boolean(process.env["CLAUDE_CODE_OAUTH_TOKEN"] || process.env["ANTHROPIC_API_KEY"]);
}

/** `cliPath: null` -> `<dirname(process.execPath)>/claude` if it exists (nvm installs node and
 *  claude in the same bin dir; the systemd service has no PATH), else the bare string `"claude"`
 *  (resolved via PATH by the OS at spawn time). */
function resolveCliPath(cfg: AiAnalystConfig): string {
  if (cfg.cliPath !== null) return cfg.cliPath;
  const candidate = join(dirname(process.execPath), "claude");
  return existsSync(candidate) ? candidate : "claude";
}

function buildCliArgs(cfg: AiAnalystConfig, input: AiAnalystInput): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "",
    "--permission-mode", "dontAsk",
    "--max-turns", String(2 + 2 * cfg.webSearchMaxUses),
    "--model", cfg.model,
    "--effort", cfg.effort,
    "--json-schema", AI_OUTPUT_JSON_SCHEMA,
    "--system-prompt", input.systemPrompt,
  ];
  if (cfg.webSearchMaxUses > 0) {
    args.push("--tools", "WebSearch", "--allowedTools", "WebSearch");
  } else {
    args.push("--tools", "");
  }
  return args;
}

/** Same JSON the SDK adapter sends as its user-turn content (src/research/ai/anthropic-client.ts) —
 *  duplicated rather than shared, since the two adapters' request shapes are otherwise unrelated
 *  (one is a single SDK message, the other a CLI stdin payload) and this is the only overlap. */
function buildUserContent(input: AiAnalystInput): string {
  return JSON.stringify({
    dateUtc: input.dateUtc,
    decisionTime: input.decisionTime,
    sources: input.sources,
    features: input.features,
    outcomes: input.outcomes,
    rulePlans: input.rulePlans,
    openTrades: input.openTrades,
    configSymbols: input.configSymbols,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Best-effort JSONL parse: a line that isn't valid JSON is skipped rather than failing the
 *  whole call — a stream that never produces a `result` event ends up in the "no result event"
 *  api_error path anyway (fail closed, nothing is ever guessed from a malformed line). */
function parseJsonLines(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip
    }
  }
  return events;
}

/** Every `user` event whose `tool_use_result` is an object with `results[]` — one entry per
 *  distinct web search call — contributes its `results[N].content[]` items (each `{title, url}`)
 *  in order. The "Links: [...]" string form inside `message.content[].tool_result.content` is
 *  never parsed (per this change's brief: the object form is authoritative). */
function extractWebResults(events: readonly unknown[]): { url: string; title: string; pageAge: string | null }[] {
  const out: { url: string; title: string; pageAge: string | null }[] = [];
  for (const event of events) {
    if (!isRecord(event) || event["type"] !== "user") continue;
    const toolUseResult = event["tool_use_result"];
    if (!isRecord(toolUseResult) || !Array.isArray(toolUseResult["results"])) continue;
    for (const result of toolUseResult["results"] as unknown[]) {
      if (!isRecord(result) || !Array.isArray(result["content"])) continue;
      for (const item of result["content"] as unknown[]) {
        if (isRecord(item) && typeof item["url"] === "string" && typeof item["title"] === "string") {
          out.push({ url: item["url"], title: item["title"], pageAge: null });
        }
      }
    }
  }
  return out;
}

interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
}

/** Sums every model actually used (a search sub-task can route to a different, cheaper model
 *  than the main turn) — never the terminal event's top-level `usage.server_tool_use.
 *  web_search_requests`, which stays 0 even when a search ran (verified against 2.1.274). */
function usageFromModelUsage(modelUsage: Record<string, ModelUsageEntry>): { inputTokens: number; outputTokens: number; webSearchRequests: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let webSearchRequests = 0;
  for (const m of Object.values(modelUsage)) {
    inputTokens += (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
    outputTokens += m.outputTokens ?? 0;
    webSearchRequests += m.webSearchRequests ?? 0;
  }
  return { inputTokens, outputTokens, webSearchRequests };
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : "";
}

interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  structured_output?: unknown;
  result?: string;
  total_cost_usd?: number;
  modelUsage?: Record<string, ModelUsageEntry>;
}

function isResultEvent(v: unknown): v is ResultEvent {
  return isRecord(v) && v["type"] === "result" && typeof v["subtype"] === "string" && typeof v["is_error"] === "boolean";
}

/** Stage 2 (see file header): everything done with the child's finished output. Never throws —
 *  every branch returns an `AiCallResult`, and the raw-file write is wrapped separately so a
 *  write failure can't prevent returning a `failed` result either. */
function handleOutput(stdout: string, stderr: string, exitCode: number | null, snapshotRoot: string, dateUtc: string): AiCallResult {
  const events = parseJsonLines(stdout);

  try {
    writeRawResponseOnce(snapshotRoot, dateUtc, events);
  } catch (err) {
    return { kind: "failed", reason: "api_error", detail: `could not write raw response: ${(err as Error).message}`, usage: null };
  }

  const resultEvent = events.find(isResultEvent);
  if (!resultEvent) {
    const lastStderr = lastNonEmptyLine(stderr);
    return {
      kind: "failed", reason: "api_error",
      detail: `claude CLI exited ${exitCode ?? "null"} with no result event${lastStderr ? `: ${lastStderr}` : ""}`,
      usage: null,
    };
  }

  const usage = usageFromModelUsage(resultEvent.modelUsage ?? {});
  const servedByModel = Object.keys(resultEvent.modelUsage ?? {}).join(",");
  const listCostUsd = resultEvent.total_cost_usd ?? 0;

  if (resultEvent.subtype === "error_max_structured_output_retries") {
    return { kind: "failed", reason: "schema_invalid", detail: "claude CLI exhausted structured-output retries", usage };
  }
  if (resultEvent.subtype === "error_max_turns") {
    return { kind: "failed", reason: "max_tokens", detail: "claude CLI hit --max-turns before completing (closest failure to a token/output cap)", usage };
  }
  if (resultEvent.is_error) {
    const text = typeof resultEvent.result === "string" ? resultEvent.result : "";
    if (/401|auth/i.test(text)) {
      return { kind: "failed", reason: "api_error", detail: "authentication failed — check CLAUDE_CODE_OAUTH_TOKEN", usage };
    }
    if (/429|rate limit/i.test(text)) return { kind: "failed", reason: "rate_limited", detail: text, usage };
    if (/refus/i.test(text)) return { kind: "failed", reason: "refusal", detail: text, usage };
    return { kind: "failed", reason: "api_error", detail: text || `claude CLI reported an error (subtype "${resultEvent.subtype}")`, usage };
  }
  if (resultEvent.subtype !== "success" || resultEvent.structured_output === undefined) {
    return { kind: "failed", reason: "api_error", detail: `unexpected result subtype "${resultEvent.subtype}"`, usage };
  }

  const parsed = aiAnalystOutputSchema.safeParse(resultEvent.structured_output);
  if (!parsed.success) {
    return { kind: "failed", reason: "schema_invalid", detail: parsed.error.message, usage };
  }

  const rawResponsePath = join(snapshotRoot, dateUtc, "ai-analyst.raw.json");
  return {
    kind: "ok",
    output: parsed.data as AiAnalystOutput,
    webResults: extractWebResults(events),
    usage,
    servedByModel,
    rawResponsePath,
    listCostUsd,
  };
}

export function createClaudeCliAiClient(cfg: AiAnalystConfig, snapshotRoot: string, deps: ClaudeCliClientDeps = {}): AiClientPort {
  return {
    async analyze(input: AiAnalystInput): Promise<AiCallResult> {
      if (!hasCredential()) {
        return {
          kind: "failed", reason: "no_api_key",
          detail: "neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set",
          usage: null,
        };
      }

      const cliPath = resolveCliPath(cfg);
      const tmpDir = mkdtempSync(join(tmpdir(), "ai-claude-cli-"));
      try {
        // Never log this object: it carries whichever credential is set. Deleting
        // ANTHROPIC_API_KEY when the OAuth token is present guarantees the subscription is used
        // and no API billing can happen by accident (both env vars satisfy hasCredential() above,
        // but the CLI itself would prefer whichever it finds — this makes the choice explicit).
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        if (childEnv["CLAUDE_CODE_OAUTH_TOKEN"]) delete childEnv["ANTHROPIC_API_KEY"];

        const args = buildCliArgs(cfg, input);
        const spawnFn = deps.spawn ?? ((command, spawnArgs, options) => nodeSpawn(command, spawnArgs, options) as unknown as ChildProcessLike);

        return await new Promise<AiCallResult>((resolve) => {
          let settled = false;
          const settle = (result: AiCallResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
          };

          let child: ChildProcessLike;
          try {
            child = spawnFn(cliPath, args, { cwd: tmpDir, env: childEnv });
          } catch (err) {
            settle({ kind: "failed", reason: "api_error", detail: `failed to spawn "${cliPath}": ${(err as Error).message}`, usage: null });
            return;
          }

          const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already exited */ }
            settle({ kind: "failed", reason: "timeout", detail: `claude CLI exceeded ${cfg.timeoutMs}ms`, usage: null });
          }, cfg.timeoutMs);

          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += chunk; });
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.on("error", (err) => {
            settle({ kind: "failed", reason: "api_error", detail: `failed to spawn "${cliPath}": ${err.message}`, usage: null });
          });
          child.on("close", (code) => {
            settle(handleOutput(stdout, stderr, code, snapshotRoot, input.dateUtc));
          });

          try {
            child.stdin.write(buildUserContent(input));
            child.stdin.end();
          } catch (err) {
            settle({ kind: "failed", reason: "api_error", detail: `failed to write to claude CLI stdin: ${(err as Error).message}`, usage: null });
          }
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}
