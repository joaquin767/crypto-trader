// Rules tests — specs/daily-catalyst-manual-trading.md §5.4, AC-8, AC-9, AC-10.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { FeatureValue, FeatureVector } from "../src/research/types.ts";
import type { RuleDefinition } from "../src/research/rules.ts";
import { evaluateRule, evaluateThesis, parseRuleSet, RuleSetValidationError, ruleHash } from "../src/research/rules.ts";

const CONFIG_SYMBOLS = ["APT/USDT", "SOL/USDT"];

function baseRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "test-rule",
    version: 1,
    description: "a test rule",
    evidence: ["X1"],
    status: "experimental",
    symbols: ["APT/USDT"],
    side: "long",
    entryWhenAll: [{ feature: "fearGreed", op: ">", value: 50 }],
    invalidateWhenAny: [],
    stopAtrMultiple: 2,
    targetRMultiple: 3,
    maxHoldDays: 5,
    forwardOnly: false,
    origin: "rules-file",
    ...overrides,
  };
}

function val(value: number): FeatureValue {
  return { kind: "value", value, availableAt: 0, sourceId: "fear-greed" };
}
function missingFv(reason = "missing"): FeatureValue {
  return { kind: "missing", reason, sourceId: "fear-greed" };
}

function baseFv(overrides: Partial<Record<string, FeatureValue>> = {}): FeatureVector {
  const features: Record<string, FeatureValue> = {
    close: val(100), return1d: val(1), return7d: val(1), atr14d: val(5), realizedVol7d: val(10),
    fundingRate8hAvg3d: val(0.01), fundingRatePercentile90d: val(50), oiChange3dPct: val(1),
    btcEtfNetFlowUsd1d: val(1), btcEtfNetFlowUsd5d: val(1), ethEtfNetFlowUsd1d: val(1),
    stablecoinSupplyChange7dPct: val(1), fearGreed: val(60),
    hoursToNextFomc: val(100), hoursToNextCpi: val(100), daysToNextUnlock: val(999), nextUnlockPctOfFloat: val(0),
    ...overrides,
  };
  return { symbol: "APT/USDT", decisionTime: 0, features: features as FeatureVector["features"] };
}

// ── parseRuleSet / AC-8 ─────────────────────────────────────────────────────────────────────

test("AC-8: a rule set with 3 distinct errors yields exactly 3 issues", () => {
  const json = {
    schemaVersion: 1,
    rules: [
      {
        id: "BAD ID!", // 1. invalid id
        version: 1,
        description: "d",
        evidence: ["X1"],
        status: "experimental",
        symbols: ["APT/USDT"],
        side: "long",
        entryWhenAll: [{ feature: "fearGreed", op: ">", value: 50 }],
        invalidateWhenAny: [],
        stopAtrMultiple: 2,
        targetRMultiple: 3,
        maxHoldDays: 5,
        forwardOnly: false,
        origin: "rules-file",
      },
      {
        id: "second-rule",
        version: 0, // 2. version must be >= 1
        description: "d",
        evidence: ["X1"],
        status: "experimental",
        symbols: ["NOT/CONFIGURED"], // 3. symbol not in config
        side: "long",
        entryWhenAll: [{ feature: "fearGreed", op: ">", value: 50 }],
        invalidateWhenAny: [],
        stopAtrMultiple: 2,
        targetRMultiple: 3,
        maxHoldDays: 5,
        forwardOnly: false,
        origin: "rules-file",
      },
    ],
  };
  assert.throws(
    () => parseRuleSet(json, CONFIG_SYMBOLS),
    (err: unknown) => {
      assert.ok(err instanceof RuleSetValidationError);
      assert.equal(err.issues.length, 3);
      return true;
    },
  );
});

test("parseRuleSet accepts a valid rule set", () => {
  const rule = baseRule();
  const parsed = parseRuleSet({ schemaVersion: 1, rules: [rule] }, CONFIG_SYMBOLS);
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0]!.id, "test-rule");
});

test("parseRuleSet: schemaVersion must be 1", () => {
  assert.throws(() => parseRuleSet({ schemaVersion: 2, rules: [] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

test("parseRuleSet: entryWhenAll must have length >= 1 for a rules-file rule", () => {
  const rule = baseRule({ entryWhenAll: [] });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [rule] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

test("parseRuleSet: origin must be \"rules-file\"", () => {
  const rule = baseRule({ origin: "ai-analyst" as RuleDefinition["origin"] });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [rule] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

test("parseRuleSet: evidence may be empty only when status is experimental", () => {
  const okRule = baseRule({ evidence: [] }); // status experimental by default -> OK
  assert.doesNotThrow(() => parseRuleSet({ schemaVersion: 1, rules: [okRule] }, CONFIG_SYMBOLS));

  const badRule = baseRule({ evidence: [], status: "holdout-passed" });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [badRule] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

test("parseRuleSet: stopAtrMultiple, targetRMultiple, maxHoldDays ranges", () => {
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [baseRule({ stopAtrMultiple: 0 })] }, CONFIG_SYMBOLS), RuleSetValidationError);
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [baseRule({ stopAtrMultiple: 11 })] }, CONFIG_SYMBOLS), RuleSetValidationError);
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [baseRule({ targetRMultiple: 0 })] }, CONFIG_SYMBOLS), RuleSetValidationError);
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [baseRule({ targetRMultiple: 21 })] }, CONFIG_SYMBOLS), RuleSetValidationError);
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [baseRule({ maxHoldDays: 0 })] }, CONFIG_SYMBOLS), RuleSetValidationError);
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [baseRule({ maxHoldDays: 11 })] }, CONFIG_SYMBOLS), RuleSetValidationError);
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [baseRule({ maxHoldDays: 1.5 })] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

test("parseRuleSet: a \"between\" condition requires a [lo, hi] tuple with lo <= hi", () => {
  const badTuple = baseRule({ entryWhenAll: [{ feature: "fearGreed", op: "between", value: [80, 20] }] });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [badTuple] }, CONFIG_SYMBOLS), RuleSetValidationError);

  const notATuple = baseRule({ entryWhenAll: [{ feature: "fearGreed", op: "between", value: 50 }] });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [notATuple] }, CONFIG_SYMBOLS), RuleSetValidationError);

  const ok = baseRule({ entryWhenAll: [{ feature: "fearGreed", op: "between", value: [20, 80] }] });
  assert.doesNotThrow(() => parseRuleSet({ schemaVersion: 1, rules: [ok] }, CONFIG_SYMBOLS));
});

test("parseRuleSet: a non-\"between\" op requires a single number, not a tuple", () => {
  const bad = baseRule({ entryWhenAll: [{ feature: "fearGreed", op: ">", value: [1, 2] as unknown as number }] });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [bad] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

test("parseRuleSet: a condition's feature must be a valid FeatureName", () => {
  const bad = baseRule({ entryWhenAll: [{ feature: "notAFeature" as never, op: ">", value: 1 }] });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [bad] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

test("parseRuleSet: duplicate rule ids are an issue", () => {
  const r1 = baseRule({ id: "dup-rule" });
  const r2 = baseRule({ id: "dup-rule" });
  assert.throws(() => parseRuleSet({ schemaVersion: 1, rules: [r1, r2] }, CONFIG_SYMBOLS), RuleSetValidationError);
});

// ── ruleHash / AC-10 ────────────────────────────────────────────────────────────────────────

test("AC-10: any field change alters the hash; key reordering does not", () => {
  const rule = baseRule();
  const hash1 = ruleHash(rule);

  const changed = baseRule({ stopAtrMultiple: 3 });
  assert.notEqual(ruleHash(changed), hash1);

  // Rebuild the same rule with keys inserted in a different order — JS preserves insertion
  // order for string keys, so this actually produces a differently-ordered object.
  const reordered: RuleDefinition = {
    origin: rule.origin,
    forwardOnly: rule.forwardOnly,
    maxHoldDays: rule.maxHoldDays,
    targetRMultiple: rule.targetRMultiple,
    stopAtrMultiple: rule.stopAtrMultiple,
    invalidateWhenAny: rule.invalidateWhenAny,
    entryWhenAll: rule.entryWhenAll,
    side: rule.side,
    symbols: rule.symbols,
    status: rule.status,
    evidence: rule.evidence,
    description: rule.description,
    version: rule.version,
    id: rule.id,
  };
  assert.equal(ruleHash(reordered), hash1);
});

// ── evaluateRule / AC-9 ─────────────────────────────────────────────────────────────────────

test("AC-9: first condition fails, second references a missing feature -> not_evaluable", () => {
  const rule = baseRule({
    entryWhenAll: [
      { feature: "fearGreed", op: ">", value: 999 }, // fails (fearGreed=60)
      { feature: "return7d", op: ">", value: 0 },
    ],
  });
  const fv = baseFv({ return7d: missingFv("no data") });
  const outcome = evaluateRule(rule, fv);
  assert.equal(outcome.result, "not_evaluable");
  if (outcome.result === "not_evaluable") assert.deepEqual(outcome.missing, ["return7d"]);
});

test("evaluateRule: all conditions pass -> triggered, with evidence for every referenced feature", () => {
  const rule = baseRule({
    entryWhenAll: [
      { feature: "fearGreed", op: ">", value: 50 },
      { feature: "return1d", op: "between", value: [-5, 5] },
    ],
  });
  const fv = baseFv();
  const outcome = evaluateRule(rule, fv);
  assert.equal(outcome.result, "triggered");
  if (outcome.result === "triggered") {
    assert.deepEqual(outcome.evidence, { fearGreed: 60, return1d: 1 });
    assert.equal(outcome.ruleHash, ruleHash(rule));
  }
});

test("evaluateRule: a failing condition with no missing features -> not_triggered", () => {
  const rule = baseRule({ entryWhenAll: [{ feature: "fearGreed", op: ">", value: 999 }] });
  const outcome = evaluateRule(rule, baseFv());
  assert.equal(outcome.result, "not_triggered");
  if (outcome.result === "not_triggered") assert.deepEqual(outcome.failed, ["fearGreed"]);
});

// ── evaluateThesis / AC-19 ──────────────────────────────────────────────────────────────────

test("AC-19: an invalidateWhenAny condition that is met -> invalidated", () => {
  const rule = baseRule({ invalidateWhenAny: [{ feature: "fearGreed", op: "<", value: 70 }] });
  const thesis = evaluateThesis(rule, baseFv()); // fearGreed=60 < 70 -> true
  assert.equal(thesis.state, "invalidated");
  assert.deepEqual(thesis.conditions, ["fearGreed"]);
});

test("evaluateThesis: no condition met and none missing -> intact", () => {
  const rule = baseRule({ invalidateWhenAny: [{ feature: "fearGreed", op: "<", value: 10 }] });
  const thesis = evaluateThesis(rule, baseFv());
  assert.equal(thesis.state, "intact");
  assert.deepEqual(thesis.conditions, []);
});

test("evaluateThesis: an empty invalidateWhenAny is always intact", () => {
  const rule = baseRule({ invalidateWhenAny: [] });
  const thesis = evaluateThesis(rule, baseFv());
  assert.equal(thesis.state, "intact");
});

test("evaluateThesis: a missing referenced feature -> not_evaluable", () => {
  const rule = baseRule({ invalidateWhenAny: [{ feature: "return7d", op: "<", value: 0 }] });
  const fv = baseFv({ return7d: missingFv("no data") });
  const thesis = evaluateThesis(rule, fv);
  assert.equal(thesis.state, "not_evaluable");
  assert.deepEqual(thesis.conditions, ["return7d"]);
});
