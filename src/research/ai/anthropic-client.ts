// Anthropic AI client — specs/daily-catalyst-manual-trading.md §5.13, §4.17, §10.1, §10.2.
//
// The only module importing `@anthropic-ai/sdk` (gate §12.10). Implements `AiClientPort`, which
// MUST resolve, never reject (§5.13). Two separate try/catch stages guarantee that, matching the
// two separate ways a throw could otherwise escape:
//  1. Building the request and awaiting the response (`callOnce`/its 400-retry) — a thrown
//     `APIError`/network/timeout error is mapped by `mapThrownError`.
//  2. Everything done WITH a successful response — `writeRawResponseOnce` (./raw-response.ts,
//     shared with src/research/ai/claude-cli-client.ts; its mkdirSync/writeFileSync rethrow
//     anything but EEXIST) plus reading usage/content off it — is wrapped in its own try/catch
//     below, so a write failure (e.g. an unwritable `snapshotRoot`) resolves
//     `{kind:"failed", reason:"api_error", ...}` instead of rejecting.
//
// Testability seam (`deps.makeClient`): the default constructs `new Anthropic({timeout})`, same
// as before; a test passes a fake object shaped like `{ beta: { messages: { stream } } }` so
// tests/ai-anthropic-client.test.ts can exercise the whole response-handling path (parsing,
// refusal/max_tokens/schema_invalid, the fallback retry, error mapping, the raw-file write-once)
// without a network call. The no-api-key check still runs before `makeClient` is invoked at all.
//
// SDK usage taken from the installed typings (not from memory, per §10.1/A17 and this change's
// own instructions):
//  - `client.beta.messages.stream(...)` (streamed request, `timeoutMs` from config) then
//    `.finalMessage()` — node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.d.ts.
//  - `thinking: {type:"adaptive"}` — BetaThinkingConfigAdaptive.
//  - Structured output via `output_config: {effort, format: {type:"json_schema", schema}}` —
//    BetaOutputConfig/BetaJSONOutputFormat (messages.d.ts ~2999-3010, ~2510-2518). The schema
//    object is `JSON.parse(AI_OUTPUT_JSON_SCHEMA)` from ./output-schema.ts — the SDK's
//    `zodOutputFormat` schema serialised once there, so the request body and the
//    `promptVersionHash` input are the same canonical string (see that file's header).
//  - Web search tool `web_search_20260209` with `max_uses` (omitted entirely when
//    `webSearchMaxUses` is 0) — BetaWebSearchTool20260209 (messages.d.ts:4772-4810).
//  - Refusal fallback: `fallbacks: "default"` plus the `betas` array entry
//    `server-side-fallback-2026-07-01` (BetaFallbacksParam, AnthropicBeta union). §10.1/A17: the
//    typings gave no explicit statement that fallbacks and `output_config.format` cannot combine
//    in the same request, so this sends both; if the API itself rejects the combination (a 400
//    at request-validation time, before any content is generated), the request is retried once
//    without fallbacks (and without the fallback beta flag), and a `stop_reason: "refusal"` from
//    then on is reported as `failed: "refusal"` with no further fallback — exactly A17's
//    fallback-is-the-part-dropped resolution.
//  - `betas: ["structured-outputs-2025-11-13", ...]` — the beta flag structured outputs need
//    (AnthropicBeta union, beta.d.ts).
//  - Web search results are read from `web_search_tool_result` content blocks
//    (`{url, title, page_age}` per `BetaWebSearchResultBlock`); the request-count for billing
//    comes from `usage.server_tool_use.web_search_requests`, not a manual block count.
//
// `no_api_key` is detected before any request is built: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
// are the two synchronous credential paths the SDK's own constructor checks
// (node_modules/@anthropic-ai/sdk/client.js:75-77); anything beyond that (e.g. a config-file or
// OAuth credential chain) isn't introspectable without duplicating private SDK internals, so it
// is covered defensively by the `makeClient()` try/catch below instead, per this change's brief
// ("if the SDK constructor itself throws without a key, catch that inside the client and return
// no_api_key"). This keeps AC-51 deterministic: no network call is possible when neither env var
// is set, because the client is never constructed.

import Anthropic, { APIError } from "@anthropic-ai/sdk";

import { AI_OUTPUT_JSON_SCHEMA, aiAnalystOutputSchema } from "./output-schema.ts";
import { writeRawResponseOnce } from "./raw-response.ts";
import type { AiAnalystConfig, AiAnalystInput, AiAnalystOutput, AiCallResult, AiClientPort } from "./types.ts";

/** The minimal shape this module actually calls — deliberately looser than the SDK's own
 *  `Anthropic` type so a test can substitute a fake without implementing the whole client. */
type StreamingClient = {
  beta: { messages: { stream: (params: unknown, opts?: unknown) => { finalMessage(): Promise<unknown> } } };
};

export interface AnthropicClientDeps {
  makeClient?: () => StreamingClient;
}

/** Fields this module reads off the resolved message — narrower than `BetaMessage`, since
 *  `finalMessage()` is typed `Promise<unknown>` for the fake-client seam above; both the real SDK
 *  response and a test's fake response are cast to this shape. */
interface AnthropicMessage {
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; server_tool_use: { web_search_requests: number } | null };
  content: Array<{ type: string; text?: string; content?: unknown }>;
}

function hasSyncCredential(): boolean {
  return Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]);
}

function usageOf(message: AnthropicMessage) {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    webSearchRequests: message.usage.server_tool_use?.web_search_requests ?? 0,
  };
}

/** Best-effort usage extraction for an error path where `message` itself may be malformed or
 *  entirely absent — never throws. */
function usageOfSafe(message: AnthropicMessage | undefined): { inputTokens: number; outputTokens: number; webSearchRequests: number } | null {
  if (!message) return null;
  try {
    return usageOf(message);
  } catch {
    return null;
  }
}

function mapThrownError(err: unknown): AiCallResult {
  if (err instanceof APIError) {
    if (err.status === 429) return { kind: "failed", reason: "rate_limited", detail: err.message, usage: null };
    return { kind: "failed", reason: "api_error", detail: `${err.status ?? "?"}: ${err.message}`, usage: null };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed?\s*out|timeout/i.test(message)) return { kind: "failed", reason: "timeout", detail: message, usage: null };
  return { kind: "failed", reason: "api_error", detail: message, usage: null };
}

function defaultMakeClient(cfg: AiAnalystConfig): StreamingClient {
  return new Anthropic({ timeout: cfg.timeoutMs }) as unknown as StreamingClient;
}

export function createAnthropicAiClient(cfg: AiAnalystConfig, snapshotRoot: string, deps: AnthropicClientDeps = {}): AiClientPort {
  return {
    async analyze(input: AiAnalystInput): Promise<AiCallResult> {
      if (!hasSyncCredential()) {
        return {
          kind: "failed", reason: "no_api_key",
          detail: "neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set",
          usage: null,
        };
      }

      let client: StreamingClient;
      try {
        client = (deps.makeClient ?? (() => defaultMakeClient(cfg)))();
      } catch (err) {
        return { kind: "failed", reason: "no_api_key", detail: `could not construct Anthropic client: ${(err as Error).message}`, usage: null };
      }

      const userContent = JSON.stringify({
        dateUtc: input.dateUtc,
        decisionTime: input.decisionTime,
        sources: input.sources,
        features: input.features,
        outcomes: input.outcomes,
        rulePlans: input.rulePlans,
        openTrades: input.openTrades,
        configSymbols: input.configSymbols,
      });

      const outputSchema = JSON.parse(AI_OUTPUT_JSON_SCHEMA) as Record<string, unknown>;
      const tools = cfg.webSearchMaxUses > 0
        ? [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: cfg.webSearchMaxUses }]
        : undefined;

      const baseParams = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system: input.systemPrompt,
        messages: [{ role: "user" as const, content: userContent }],
        thinking: { type: "adaptive" as const },
        output_config: { effort: cfg.effort, format: { type: "json_schema" as const, schema: outputSchema } },
        ...(tools ? { tools } : {}),
      };

      async function callOnce(withFallback: boolean): Promise<AnthropicMessage> {
        const raw = await client.beta.messages
          .stream(
            {
              ...baseParams,
              ...(withFallback ? { fallbacks: "default" as const } : {}),
              betas: [
                "structured-outputs-2025-11-13",
                ...(withFallback ? (["server-side-fallback-2026-07-01"] as const) : []),
              ],
            },
            { timeout: cfg.timeoutMs },
          )
          .finalMessage();
        return raw as AnthropicMessage;
      }

      // ── Stage 1: build the request and await a response. Any throw here (network, timeout,
      // APIError) is mapped and resolved, never rethrown (§5.13 "MUST resolve, never throws"). ──
      let message: AnthropicMessage;
      try {
        message = await callOnce(true);
      } catch (firstErr) {
        // A17: fallbacks may not combine with output_config.format — a 400 at request-validation
        // time (never a completed response) means the combination itself was rejected, not a
        // model refusal. Drop fallbacks and retry once; any other error is terminal.
        if (firstErr instanceof APIError && firstErr.status === 400) {
          try {
            message = await callOnce(false);
          } catch (secondErr) {
            return mapThrownError(secondErr);
          }
        } else {
          return mapThrownError(firstErr);
        }
      }

      // ── Stage 2: everything done with a successful response. Wrapped so a write failure (e.g.
      // an unwritable snapshotRoot) or any other unexpected throw resolves instead of rejecting. ──
      try {
        const rawResponsePath = writeRawResponseOnce(snapshotRoot, input.dateUtc, message);
        const usage = usageOf(message);

        if (message.stop_reason === "refusal") {
          return { kind: "failed", reason: "refusal", detail: "the model refused to respond", usage };
        }
        if (message.stop_reason === "max_tokens") {
          return { kind: "failed", reason: "max_tokens", detail: "response truncated at max_tokens", usage };
        }

        const textBlocks = message.content.filter((b) => b.type === "text");
        const text = textBlocks.map((b) => b.text ?? "").join("");
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(text);
        } catch (err) {
          return { kind: "failed", reason: "schema_invalid", detail: `response is not valid JSON: ${(err as Error).message}`, usage };
        }
        const parsed = aiAnalystOutputSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return { kind: "failed", reason: "schema_invalid", detail: parsed.error.message, usage };
        }

        const webResults: { url: string; title: string; pageAge: string | null }[] = [];
        for (const block of message.content) {
          if (block.type !== "web_search_tool_result") continue;
          if (!Array.isArray(block.content)) continue; // an error result — no results on this call
          for (const r of block.content as { url: string; title: string; page_age: string | null }[]) {
            webResults.push({ url: r.url, title: r.title, pageAge: r.page_age });
          }
        }

        return {
          kind: "ok",
          output: parsed.data as AiAnalystOutput,
          webResults,
          usage,
          servedByModel: message.model,
          rawResponsePath,
        };
      } catch (err) {
        return { kind: "failed", reason: "api_error", detail: (err as Error).message ?? String(err), usage: usageOfSafe(message) };
      }
    },
  };
}
