// Rules — specs/daily-catalyst-manual-trading.md §5.4.
//
// parseRuleSet validates a JSON research-rules.json file and collects EVERY issue instead of
// throwing on the first one (AC-8), so the owner sees the whole list at once (exit 2, §5.12).
// evaluateRule/evaluateThesis are pure and deliberately conservative: per §5.4/AC-9, ANY
// referenced feature missing makes the result `not_evaluable`, even when another condition
// already fails/passes — we never claim a confident triggered/not_triggered verdict on partial
// data (P1: fail closed). evaluateThesis applies the same conservative rule to
// `invalidateWhenAny`, for the same reason, even though the spec's normative prose (§5.4) only
// spells this out for `evaluateRule`.

import { createHash } from "node:crypto";

import type { FeatureName, FeatureVector } from "./types.ts";

export type Comparator = "<" | "<=" | ">" | ">=" | "between";

export interface Condition {
  feature: FeatureName;
  op: Comparator;
  value: number | [number, number];
}

export interface RuleDefinition {
  id: string; // /^[a-z0-9-]{3,48}$/
  version: number; // integer >= 1, bumped on any change
  description: string;
  evidence: string[]; // IDs from §2.2, e.g. ["X1"]; may be empty only if status is "experimental" or origin is "ai-analyst"
  status: "experimental" | "holdout-passed" | "paper-passed" | "retired";
  symbols: string[]; // subset of config.symbols
  side: "long" | "short";
  entryWhenAll: Condition[]; // length >= 1 for origin "rules-file"; empty for origin "ai-analyst"
  invalidateWhenAny: Condition[]; // thesis invalidation, re-checked while a trade is open
  stopAtrMultiple: number; // (0, 10]
  targetRMultiple: number; // (0, 20]
  maxHoldDays: number; // integer 1..10
  forwardOnly: boolean; // true if any feature lacks point-in-time history (§10.3)
  origin: "rules-file" | "ai-analyst"; // parseRuleSet requires "rules-file"; "ai-analyst" rules are built only by aiIdeaToRule (§5.13)
}

export interface RuleSet {
  schemaVersion: 1;
  rules: RuleDefinition[];
}

export class RuleSetValidationError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super(`research-rules.json failed validation with ${issues.length} issue(s): ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "RuleSetValidationError";
    this.issues = issues;
  }
}

const ID_RE = /^[a-z0-9-]{3,48}$/;
const RULE_STATUSES = ["experimental", "holdout-passed", "paper-passed", "retired"] as const;
const SIDES = ["long", "short"] as const;
const COMPARATORS: readonly Comparator[] = ["<", "<=", ">", ">=", "between"];

export const FEATURE_NAMES: readonly FeatureName[] = [
  "close", "return1d", "return7d", "atr14d", "realizedVol7d",
  "fundingRate8hAvg3d", "fundingRatePercentile90d", "oiChange3dPct",
  "btcEtfNetFlowUsd1d", "btcEtfNetFlowUsd5d", "ethEtfNetFlowUsd1d",
  "stablecoinSupplyChange7dPct", "fearGreed",
  "hoursToNextFomc", "hoursToNextCpi", "daysToNextUnlock", "nextUnlockPctOfFloat",
];

function isFeatureName(v: unknown): v is FeatureName {
  return typeof v === "string" && (FEATURE_NAMES as readonly string[]).includes(v);
}

type Issue = { path: string; message: string };

function validateCondition(cond: unknown, path: string, issues: Issue[]): void {
  if (typeof cond !== "object" || cond === null) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  const c = cond as Record<string, unknown>;
  if (!isFeatureName(c["feature"])) {
    issues.push({ path: `${path}.feature`, message: `must be a valid FeatureName, got ${JSON.stringify(c["feature"])}` });
  }
  const op = c["op"];
  if (typeof op !== "string" || !(COMPARATORS as readonly string[]).includes(op)) {
    issues.push({ path: `${path}.op`, message: `must be one of ${COMPARATORS.join(", ")}` });
    return; // can't validate `value` shape without a known op
  }
  const value = c["value"];
  if (op === "between") {
    if (
      !Array.isArray(value) || value.length !== 2 ||
      typeof value[0] !== "number" || typeof value[1] !== "number" || !(value[0] <= value[1])
    ) {
      issues.push({ path: `${path}.value`, message: "op \"between\" requires a [lo, hi] tuple of numbers with lo <= hi" });
    }
  } else {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path: `${path}.value`, message: `op "${op}" requires a single finite number` });
    }
  }
}

function validateConditionArray(arr: unknown, path: string, issues: Issue[]): void {
  if (!Array.isArray(arr)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  arr.forEach((cond, i) => validateCondition(cond, `${path}[${i}]`, issues));
}

function validateRule(rule: unknown, index: number, configSymbols: readonly string[], issues: Issue[]): void {
  const path = `rules[${index}]`;
  if (typeof rule !== "object" || rule === null) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  const r = rule as Record<string, unknown>;

  if (typeof r["id"] !== "string" || !ID_RE.test(r["id"])) {
    issues.push({ path: `${path}.id`, message: "must match /^[a-z0-9-]{3,48}$/" });
  }
  if (typeof r["version"] !== "number" || !Number.isInteger(r["version"]) || r["version"] < 1) {
    issues.push({ path: `${path}.version`, message: "must be an integer >= 1" });
  }
  if (typeof r["description"] !== "string" || r["description"].length === 0) {
    issues.push({ path: `${path}.description`, message: "must be a non-empty string" });
  }

  const status = r["status"];
  if (typeof status !== "string" || !(RULE_STATUSES as readonly string[]).includes(status)) {
    issues.push({ path: `${path}.status`, message: `must be one of ${RULE_STATUSES.join(", ")}` });
  }

  if (!Array.isArray(r["evidence"]) || !r["evidence"].every((e) => typeof e === "string")) {
    issues.push({ path: `${path}.evidence`, message: "must be an array of strings" });
  } else if (r["evidence"].length === 0 && status !== "experimental") {
    issues.push({ path: `${path}.evidence`, message: "may be empty only when status is \"experimental\" (origin is always \"rules-file\" here)" });
  }

  if (!Array.isArray(r["symbols"]) || r["symbols"].length === 0 || !r["symbols"].every((s) => typeof s === "string")) {
    issues.push({ path: `${path}.symbols`, message: "must be a non-empty array of strings" });
  } else {
    for (const s of r["symbols"]) {
      if (!configSymbols.includes(s as string)) {
        issues.push({ path: `${path}.symbols`, message: `"${s}" is not in config.symbols` });
      }
    }
  }

  if (typeof r["side"] !== "string" || !(SIDES as readonly string[]).includes(r["side"])) {
    issues.push({ path: `${path}.side`, message: "must be \"long\" or \"short\"" });
  }

  validateConditionArray(r["entryWhenAll"], `${path}.entryWhenAll`, issues);
  if (Array.isArray(r["entryWhenAll"]) && r["entryWhenAll"].length === 0) {
    issues.push({ path: `${path}.entryWhenAll`, message: "must have length >= 1 (origin is always \"rules-file\" here)" });
  }

  validateConditionArray(r["invalidateWhenAny"], `${path}.invalidateWhenAny`, issues);

  if (typeof r["stopAtrMultiple"] !== "number" || !(r["stopAtrMultiple"] > 0 && r["stopAtrMultiple"] <= 10)) {
    issues.push({ path: `${path}.stopAtrMultiple`, message: "must be a number in (0, 10]" });
  }
  if (typeof r["targetRMultiple"] !== "number" || !(r["targetRMultiple"] > 0 && r["targetRMultiple"] <= 20)) {
    issues.push({ path: `${path}.targetRMultiple`, message: "must be a number in (0, 20]" });
  }
  if (
    typeof r["maxHoldDays"] !== "number" || !Number.isInteger(r["maxHoldDays"]) ||
    r["maxHoldDays"] < 1 || r["maxHoldDays"] > 10
  ) {
    issues.push({ path: `${path}.maxHoldDays`, message: "must be an integer in 1..10" });
  }

  if (typeof r["forwardOnly"] !== "boolean") {
    issues.push({ path: `${path}.forwardOnly`, message: "must be a boolean" });
  }

  if (r["origin"] !== "rules-file") {
    issues.push({ path: `${path}.origin`, message: "must be \"rules-file\" (parseRuleSet never accepts \"ai-analyst\" rules)" });
  }
}

/** Throws RuleSetValidationError listing every issue (not just the first). */
export function parseRuleSet(json: unknown, configSymbols: readonly string[]): RuleSet {
  const issues: Issue[] = [];

  if (typeof json !== "object" || json === null) {
    throw new RuleSetValidationError([{ path: "$", message: "must be an object" }]);
  }
  const root = json as Record<string, unknown>;

  if (root["schemaVersion"] !== 1) {
    issues.push({ path: "schemaVersion", message: "must be 1" });
  }
  if (!Array.isArray(root["rules"])) {
    issues.push({ path: "rules", message: "must be an array" });
    throw new RuleSetValidationError(issues);
  }

  root["rules"].forEach((rule, i) => validateRule(rule, i, configSymbols, issues));

  // Duplicate ids are a distinct, structural issue not caught per-rule above.
  const seenIds = new Map<string, number>();
  root["rules"].forEach((rule, i) => {
    if (typeof rule === "object" && rule !== null && typeof (rule as Record<string, unknown>)["id"] === "string") {
      const id = (rule as Record<string, unknown>)["id"] as string;
      if (seenIds.has(id)) {
        issues.push({ path: `rules[${i}].id`, message: `duplicate rule id "${id}" (first seen at rules[${seenIds.get(id)}])` });
      } else {
        seenIds.set(id, i);
      }
    }
  });

  if (issues.length > 0) {
    throw new RuleSetValidationError(issues);
  }
  return root as unknown as RuleSet;
}

// ── ruleHash ──────────────────────────────────────────────────────────────────────────────────

/** Recursively sorts object keys (array element order is preserved) so two rule objects that
 *  differ only in key order canonicalize identically (AC-10). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 of the canonical JSON of one rule; recorded in reports, plans, journal and gate artifacts. */
export function ruleHash(rule: RuleDefinition): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(rule))).digest("hex");
}

// ── evaluateRule / evaluateThesis ────────────────────────────────────────────────────────────

export type RuleOutcome =
  | { ruleId: string; ruleHash: string; symbol: string; result: "triggered"; evidence: Record<string, number> }
  | { ruleId: string; ruleHash: string; symbol: string; result: "not_triggered"; failed: FeatureName[] }
  | { ruleId: string; ruleHash: string; symbol: string; result: "not_evaluable"; missing: FeatureName[] };

function conditionHolds(cond: Condition, v: number): boolean {
  switch (cond.op) {
    case "<": return v < (cond.value as number);
    case "<=": return v <= (cond.value as number);
    case ">": return v > (cond.value as number);
    case ">=": return v >= (cond.value as number);
    case "between": {
      const [lo, hi] = cond.value as [number, number];
      return v >= lo && v <= hi;
    }
  }
}

/** Pure. not_evaluable if ANY referenced feature is missing — even if another condition
 *  already fails (§5.4/AC-9). */
export function evaluateRule(rule: RuleDefinition, fv: FeatureVector): RuleOutcome {
  const hash = ruleHash(rule);
  const missing: FeatureName[] = [];
  const values = new Map<FeatureName, number>();

  for (const cond of rule.entryWhenAll) {
    const fval = fv.features[cond.feature];
    if (fval.kind === "missing") {
      if (!missing.includes(cond.feature)) missing.push(cond.feature);
    } else {
      values.set(cond.feature, fval.value);
    }
  }

  if (missing.length > 0) {
    return { ruleId: rule.id, ruleHash: hash, symbol: fv.symbol, result: "not_evaluable", missing };
  }

  const failed: FeatureName[] = [];
  for (const cond of rule.entryWhenAll) {
    const v = values.get(cond.feature)!;
    if (!conditionHolds(cond, v)) failed.push(cond.feature);
  }

  if (failed.length > 0) {
    return { ruleId: rule.id, ruleHash: hash, symbol: fv.symbol, result: "not_triggered", failed };
  }

  const evidence: Record<string, number> = {};
  for (const [feature, v] of values) evidence[feature] = v;
  return { ruleId: rule.id, ruleHash: hash, symbol: fv.symbol, result: "triggered", evidence };
}

export type ThesisState = "intact" | "invalidated" | "not_evaluable";

/** Pure. Same conservative "any missing referenced feature ⇒ not_evaluable" rule as
 *  evaluateRule applies here too, even though the spec's normative prose only spells it out
 *  for evaluateRule — see file header. */
export function evaluateThesis(rule: RuleDefinition, fv: FeatureVector): { state: ThesisState; conditions: FeatureName[] } {
  const missing: FeatureName[] = [];
  const triggered: FeatureName[] = [];

  for (const cond of rule.invalidateWhenAny) {
    const fval = fv.features[cond.feature];
    if (fval.kind === "missing") {
      if (!missing.includes(cond.feature)) missing.push(cond.feature);
      continue;
    }
    if (conditionHolds(cond, fval.value) && !triggered.includes(cond.feature)) {
      triggered.push(cond.feature);
    }
  }

  if (missing.length > 0) return { state: "not_evaluable", conditions: missing };
  if (triggered.length > 0) return { state: "invalidated", conditions: triggered };
  return { state: "intact", conditions: [] };
}
