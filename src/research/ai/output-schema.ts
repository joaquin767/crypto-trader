// AI analyst structured-output schema — specs/daily-catalyst-manual-trading.md §5.13, §10.1.
//
// This is "the one zod schema file" gate §12.10 allows to import zod and the SDK. It mirrors
// `AiAnalystOutput` (src/research/ai/types.ts) field-for-field and is the single source of truth
// for the JSON schema sent to the API.
//
// `AI_OUTPUT_JSON_SCHEMA` is generated once, at module load, through the SDK's own
// `zodOutputFormat` helper, which runs `z.toJSONSchema` and then the SDK's
// `transformJSONSchema` pass (node_modules/@anthropic-ai/sdk/lib/transform-json-schema.js).
// That pass is not optional: it removes the keywords the structured-outputs API does not accept
// (`$schema`, `maxItems`, `minItems` above 1, `prefixItems`, ...), forces
// `additionalProperties: false` on every object, and throws on shapes it cannot express — a raw
// `z.toJSONSchema` string was found to include `$schema`/`prefixItems`/`items: false`, and the
// helper threw on the tuple that produced them. So the schema below avoids tuples (see
// `conditionSchema`) and the string exported here is exactly the transformed schema.
// anthropic-client.ts parses this same string back into `output_config.format.schema`, so the
// request body and the `promptVersionHash` input are byte-identical by construction (§5.13:
// "outputJsonSchema must be the exact JSON schema string sent to the API").
//
// `aiAnalystOutputSchema` is exported too, so anthropic-client.ts can `.safeParse` the model's
// JSON response for the `schema_invalid` failure reason. Only this file and anthropic-client.ts
// depend on zod or the SDK (§12.10); every other AI module is pure TypeScript.

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { FEATURE_SOURCE_ID } from "../features.ts";
import type { FeatureName } from "../types.ts";

/** Runtime list of the feature names a ref or condition may cite: with structured outputs the
 *  model cannot invent a name, and `evaluateThesis` (src/research/rules.ts) never sees one. */
const FEATURE_NAMES = Object.keys(FEATURE_SOURCE_ID) as [FeatureName, ...FeatureName[]];

const evidenceRefSchema = z.union([
  z.object({ kind: z.literal("feature"), symbol: z.string(), feature: z.enum(FEATURE_NAMES), value: z.number() }),
  z.object({ kind: z.literal("web"), url: z.string() }),
]);

/** `Condition.value` is `number | [number, number]` (src/research/rules.ts). A `[lo, hi]` pair is
 *  expressed as a two-element number array, not `z.tuple`: the SDK transform cannot express
 *  tuples (see file header). The length bound survives in zod for `.safeParse`, so a response
 *  with another length is `schema_invalid`; `lo <= hi` is checked in verify.ts. */
const conditionSchema = z.object({
  feature: z.enum(FEATURE_NAMES),
  op: z.enum(["<", "<=", ">", ">=", "between"]),
  value: z.union([z.number(), z.array(z.number()).min(2).max(2)]),
});

const planAssessmentSchema = z.object({
  planId: z.string(),
  stance: z.enum(["support", "caution", "oppose"]),
  confidence: z.number(),
  reasons: z.array(z.object({ text: z.string(), refs: z.array(evidenceRefSchema) })),
});

const ideaSchema = z.object({
  symbol: z.string(),
  side: z.enum(["long", "short"]),
  thesis: z.string(),
  catalysts: z.array(z.string()),
  refs: z.array(evidenceRefSchema),
  invalidateWhenAny: z.array(conditionSchema),
  stopAtrMultiple: z.number(),
  targetRMultiple: z.number(),
  maxHoldDays: z.number(),
  confidence: z.number(),
});

const openTradeNoteSchema = z.object({ tradeId: z.string(), note: z.string(), refs: z.array(evidenceRefSchema) });

/** Mirrors `AiAnalystOutput` (src/research/ai/types.ts) exactly. */
export const aiAnalystOutputSchema = z.object({
  regimeSummary: z.string(),
  planAssessments: z.array(planAssessmentSchema),
  ideas: z.array(ideaSchema),
  openTradeNotes: z.array(openTradeNoteSchema),
  risks: z.array(z.string()),
  dataGaps: z.array(z.string()),
});

/** The exact JSON schema string sent to the API and hashed into `promptVersionHash` — the SDK's
 *  transformed schema, see file header. */
export const AI_OUTPUT_JSON_SCHEMA: string = JSON.stringify(zodOutputFormat(aiAnalystOutputSchema).schema);
