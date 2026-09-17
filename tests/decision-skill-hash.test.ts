// skillHash tests — specs/daily-catalyst-manual-trading.md §5.15 "skillHash — exact file set and
// algorithm", AC-110.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillHash, SkillHashError } from "../src/decision/skill-hash.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "skill-hash-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSkill(repoRoot: string): { skillRoot: string; promptPath: string } {
  const skillRoot = join(repoRoot, ".claude/skills/crypto-fundamental-analyst");
  mkdirSync(join(skillRoot, "references"), { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), "hello\n");
  writeFileSync(join(skillRoot, "references/theory.md"), "theory\n");
  const promptPath = join(repoRoot, "prompts/ai-analyst.md");
  mkdirSync(join(repoRoot, "prompts"), { recursive: true });
  writeFileSync(promptPath, "prompt\n");
  return { skillRoot, promptPath };
}

test("AC-110: identical tree hashed twice gives equal values (path order is byte order)", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const a = skillHash({ skillRoot, promptPath, repoRoot: dir });
    const b = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.equal(a, b);
  });
});

test("AC-110: a one-byte change to SKILL.md changes the hash", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    writeFileSync(join(skillRoot, "SKILL.md"), "hellp\n");
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.notEqual(before, after);
  });
});

test("AC-110: a change to any references/*.md file changes the hash", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    writeFileSync(join(skillRoot, "references/theory.md"), "theory v2\n");
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.notEqual(before, after);
  });
});

test("AC-110: a change to prompts/ai-analyst.md changes the hash", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    writeFileSync(promptPath, "prompt v2\n");
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.notEqual(before, after);
  });
});

test("AC-110: a new non-.md file under references/ changes the hash (not a *.md glob)", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    writeFileSync(join(skillRoot, "references/checklist.txt"), "a checklist\n");
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.notEqual(before, after);
  });
});

test("AC-110: a trailing-newline change (LF -> CRLF) changes the hash (raw bytes, no normalisation)", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    writeFileSync(join(skillRoot, "SKILL.md"), "hello\n");
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    writeFileSync(join(skillRoot, "SKILL.md"), "hello\r\n");
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.notEqual(before, after);
  });
});

test("AC-110: a dotfile added under the skill root does not change the hash", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    writeFileSync(join(skillRoot, ".hidden"), "secret\n");
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.equal(before, after);
  });
});

test("AC-110: only mtimes changing does not change the hash", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    const content = "hello\n";
    writeFileSync(join(skillRoot, "SKILL.md"), content); // rewritten, same bytes, new mtime
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.equal(before, after);
  });
});

test("symlinked files under the skill root are not followed and not hashed", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "outside content that must never affect the hash\n");
    symlinkSync(outside, join(skillRoot, "references/linked.md"));
    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.equal(before, after);
  });
});

test("a symlinked DIRECTORY under the skill root is not descended into, even though its own files are ordinary regular files", () => {
  withTempDir((dir) => {
    const { skillRoot, promptPath } = makeSkill(dir);
    const before = skillHash({ skillRoot, promptPath, repoRoot: dir });

    // A real directory OUTSIDE the skill root, containing an ordinary regular file — lstat on
    // the leaf file itself reports "regular file"; only the intermediate path segment
    // (references/linked-dir) is a symlink. §5.15: "symlinks are not followed and not hashed"
    // must still exclude this, even though naive leaf-only symlink detection would miss it.
    const outsideDir = join(dir, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "leaf.md"), "outside directory content that must never affect the hash\n");
    symlinkSync(outsideDir, join(skillRoot, "references/linked-dir"), "dir");

    const after = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.equal(before, after);

    // Changing the linked directory's content must still not move the hash.
    writeFileSync(join(outsideDir, "leaf.md"), "changed\n");
    const afterChange = skillHash({ skillRoot, promptPath, repoRoot: dir });
    assert.equal(before, afterChange);
  });
});

test("a missing prompt path throws SkillHashError", () => {
  withTempDir((dir) => {
    const { skillRoot } = makeSkill(dir);
    assert.throws(
      () => skillHash({ skillRoot, promptPath: join(dir, "prompts/missing.md"), repoRoot: dir }),
      SkillHashError,
    );
  });
});

test("a missing skill root throws SkillHashError", () => {
  withTempDir((dir) => {
    const { promptPath } = makeSkill(dir);
    assert.throws(
      () => skillHash({ skillRoot: join(dir, "does-not-exist"), promptPath, repoRoot: dir }),
      SkillHashError,
    );
  });
});
