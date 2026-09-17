// Phase 5 persona skill — specs/daily-catalyst-manual-trading.md §4.7, AC-39.
//
// AC-39 is a manual acceptance criterion (the owner runs the persona on a real report), but its
// mechanical half can be checked here: the skill file exists at the spec's path, its frontmatter
// is valid per the skill-creator style guide, it references the shared prompt (§4.7: "loaded from
// the same prompts/ai-analyst.md"), every local reference it names exists, and the four AC-39
// statements (a)–(d) are present as instructions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DISCLAIMER } from "../src/research/report.ts";
import { parseRuleSet } from "../src/research/rules.ts";

const SKILL_DIR = resolve(import.meta.dirname, "../.claude/skills/crypto-fundamental-analyst");
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");

function readSkill(): { frontmatter: string; body: string } {
  const text = readFileSync(SKILL_PATH, "utf-8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, "SKILL.md must start with a YAML frontmatter block");
  return { frontmatter: match[1]!, body: match[2]! };
}

test("AC-39: the persona skill exists at the spec's path", () => {
  assert.ok(existsSync(SKILL_PATH), `${SKILL_PATH} missing`);
});

test("AC-39: frontmatter is complete, description single-line, quoted, trigger-first, <= 250 chars", () => {
  const { frontmatter } = readSkill();
  assert.match(frontmatter, /^name: crypto-fundamental-analyst$/m);
  const desc = /^description: "(.+)"$/m.exec(frontmatter);
  assert.ok(desc, "description must be one quoted physical line");
  assert.ok(desc[1]!.startsWith("Trigger: "), "description must lead with trigger words");
  assert.ok(desc[1]!.length <= 250, `description is ${desc[1]!.length} chars (max 250)`);
  assert.match(frontmatter, /^license: /m);
  assert.match(frontmatter, /^metadata:\n\s+author: ".+"\n\s+version: ".+"$/m);
  assert.doesNotMatch(frontmatter, /Keywords/i);
});

test("AC-39: required sections appear in the style guide's order", () => {
  const { body } = readSkill();
  const order = ["## Activation Contract", "## Hard Rules", "## Decision Gates", "## Execution Steps", "## Output Contract", "## References"];
  let last = -1;
  for (const heading of order) {
    const at = body.indexOf(heading);
    assert.ok(at > last, `${heading} missing or out of order`);
    last = at;
  }
});

test("AC-39 (a): discusses only report rule outputs or research-rules.json-format definitions", () => {
  const { body } = readSkill();
  assert.match(body, /research-rules\.json/);
  assert.match(body, /`outcomes`, `plans`/);
  assert.match(body, /Never invent an outcome or plan/);
});

test("AC-39 (b): cites §2.2 evidence IDs and strength for every claim", () => {
  const { body } = readSkill();
  assert.match(body, /§2\.2 evidence ID \(`X1`–`X14`\) with its strength/);
});

test("AC-39 (c): never states buy/sell/size for anything not in a report's plans", () => {
  const { body } = readSkill();
  assert.match(body, /Never state buy, sell, size, leverage, or venue for anything not in the report's `plans`/);
});

test("AC-39 (d): always includes the §5.6 disclaimer literal", () => {
  const { body } = readSkill();
  assert.ok(body.includes(DISCLAIMER), "SKILL.md must carry the exact §5.6 disclaimer literal");
  assert.match(body, /End every reply with the literal line/);
});

test("§4.7: the persona loads the same prompts/ai-analyst.md as the AI channel, and every local reference exists", () => {
  const { body } = readSkill();
  assert.match(body, /prompts\/ai-analyst\.md/);
  const refs = [...body.matchAll(/`((?:\.\.\/)+prompts\/ai-analyst\.md|references\/[\w./-]+|assets\/[\w./-]+)`/g)].map((m) => m[1]!);
  assert.ok(refs.length >= 3, "expected the prompt, a references/ file and an assets/ file to be referenced");
  for (const ref of new Set(refs)) {
    assert.ok(existsSync(resolve(SKILL_DIR, ref)), `referenced local file missing: ${ref}`);
  }
});

test("the rule template is a valid research-rules.json rule", () => {
  const template = JSON.parse(readFileSync(join(SKILL_DIR, "assets/rule-template.json"), "utf-8")) as unknown;
  const set = parseRuleSet({ schemaVersion: 1, rules: [template] }, ["APT/USDT", "SOL/USDT"]);
  assert.equal(set.rules.length, 1);
  assert.equal(set.rules[0]!.status, "experimental");
  assert.equal(set.rules[0]!.origin, "rules-file");
});

test("the skill body stays within the style guide's hard budget", () => {
  const { body } = readSkill();
  const words = body.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 750, `skill body is ${words} words; the guide's hard maximum is ~1000 tokens`);
});

test("hardening: the skill carries a news protocol with search-only citations and tags", () => {
  const { body } = readSkill();
  assert.match(body, /references\/news-protocol\.md/);
  assert.match(body, /cite only URLs a search returned this session/);
  assert.match(body, /`confirmed`, `unconfirmed` or `contradicts`/);
  assert.match(body, /feature values win over any page for numbers/);
  const protocol = readFileSync(join(SKILL_DIR, "references/news-protocol.md"), "utf-8");
  assert.match(protocol, /never cite from memory/);
  assert.match(protocol, /May not: change a plan's numbers/);
});

test("hardening: the skill applies the theory reference and its thesis checklist", () => {
  const { body } = readSkill();
  assert.match(body, /references\/theory\.md/);
  assert.match(body, /thesis checklist/);
  const theory = readFileSync(join(SKILL_DIR, "references/theory.md"), "utf-8");
  for (const family of ["Flows", "Positioning / leverage", "Macro calendar", "Supply", "Sentiment / liquidity"]) {
    assert.ok(theory.includes(`| ${family} |`), `theory.md must cover the ${family} family`);
  }
  assert.match(theory, /Invalidation/);
  assert.match(theory, /Coincident vs predictive/);
});

test("hardening: staleness is stated first and every plan gets a stance that changes nothing", () => {
  const { body } = readSkill();
  assert.match(body, /State staleness first/);
  assert.match(body, /`expiresAt` has passed/);
  assert.match(body, /stance \(`support` \/ `caution` \/ `oppose`\)[^|]*AI plans included; the stance changes nothing/);
  assert.match(body, /## Output Contract[\s\S]*`Staleness`, `Evidence`[\s\S]*`News`[\s\S]*`Assessment`/);
});
