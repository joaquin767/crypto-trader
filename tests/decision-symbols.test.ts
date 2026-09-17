// Symbols — specs/daily-catalyst-manual-trading.md §13 A27, AC-115.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseRuleSet } from "../src/research/rules.ts";

const CONFIG_SYMBOLS = ["BTC/USDT", "ETH/USDT"];

test("AC-115: the shipped research-rules.json's rules only use BTC/ETH and no unlock features", () => {
  const path = resolve(import.meta.dirname, "../research-rules.json");
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  const ruleSet = parseRuleSet(raw, CONFIG_SYMBOLS);
  assert.ok(ruleSet.rules.length > 0);
  for (const rule of ruleSet.rules) {
    for (const symbol of rule.symbols) {
      assert.ok(CONFIG_SYMBOLS.includes(symbol), `rule "${rule.id}" uses symbol "${symbol}", not a subset of ${CONFIG_SYMBOLS.join(",")}`);
    }
    for (const cond of [...rule.entryWhenAll, ...rule.invalidateWhenAny]) {
      assert.ok(
        cond.feature !== "daysToNextUnlock" && cond.feature !== "nextUnlockPctOfFloat",
        `rule "${rule.id}" uses an unlock-family feature ("${cond.feature}"), inert for BTC/ETH (§13 A10/A27)`,
      );
    }
  }
});

test("AC-115: a rule listing a symbol outside config.symbols still raises a validation issue", () => {
  const badRuleSet = {
    schemaVersion: 1,
    rules: [{
      id: "outside-symbol", version: 1, description: "d", evidence: ["X1"], status: "experimental",
      symbols: ["SOL/USDT"], side: "long",
      entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
      stopAtrMultiple: 2, targetRMultiple: 2, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
    }],
  };
  assert.throws(() => parseRuleSet(badRuleSet, CONFIG_SYMBOLS));
});
