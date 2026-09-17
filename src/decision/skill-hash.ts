// skillHash — specs/daily-catalyst-manual-trading.md §5.15 "skillHash — exact file set and
// algorithm (normative)".
//
// The hash is the persona channel's rule id AND its Gate D1 identity, so it is specified to the
// byte: two implementations that disagree would silently split or merge track records. Every
// step below is transcribed from the normative numbered list in the spec — see the inline
// comments for which step each line implements.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export class SkillHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillHashError";
  }
}

/** POSIX-relative, forward-slashed, no leading "./" (step 3). */
function toPosixRelative(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  return sep === "\\" ? rel.split(sep).join("/") : rel;
}

/** Step 1+2: every regular file under `dir`, recursively, excluding dotfiles/dot-directories
 *  (any path segment starting with ".") and anything reached through a symlink.
 *
 *  This walks the tree by hand with `readdirSync(dir, { withFileTypes: true })` rather than
 *  `readdirSync(root, { recursive: true })` + a single `lstatSync` on the leaf path: that
 *  combination is NOT enough to exclude symlinks, because Node's recursive `readdirSync` happily
 *  descends *through* a symlinked directory on the way to a leaf, and the leaf file itself is a
 *  perfectly ordinary regular file — `lstatSync` on the leaf reports "regular file" and misses
 *  that an intermediate path segment was a symlink. Checking `dirent.isSymbolicLink()` on every
 *  entry *before* deciding whether to recurse into it (directory) or hash it (file) is what
 *  actually keeps a symlinked subtree — file or directory — out of the hash, matching §5.15:
 *  "symlinks are not followed and not hashed". */
function collectRegularFiles(root: string): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new SkillHashError(`skillHash: cannot list "${dir}": ${(err as Error).message}`);
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // step 2: dotfiles/dot-directories excluded
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // step 2: symlinks (file OR directory) are never followed or hashed
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      } // step 2: anything else (socket, fifo, ...) excluded
    }
  }

  walk(root);
  return out;
}

/** Steps 4-7. `opts.repoRoot` defaults to `process.cwd()`, `opts.skillRoot` to
 *  `.claude/skills/crypto-fundamental-analyst`, `opts.promptPath` to `prompts/ai-analyst.md`. A
 *  read error or a missing `<promptPath>` throws SkillHashError (exit 5, nothing written). */
export function skillHash(opts?: { skillRoot?: string; promptPath?: string; repoRoot?: string }): string {
  const repoRoot = opts?.repoRoot ?? process.cwd();
  const skillRoot = opts?.skillRoot ?? join(repoRoot, ".claude/skills/crypto-fundamental-analyst");
  const promptPath = opts?.promptPath ?? join(repoRoot, "prompts/ai-analyst.md");

  const files = collectRegularFiles(skillRoot);
  files.push(promptPath); // step 1: "plus <promptPath>"

  const entries = files.map((absPath) => {
    const relPath = toPosixRelative(repoRoot, absPath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absPath); // step 5: raw bytes, no decoding/normalisation
    } catch (err) {
      throw new SkillHashError(`skillHash: cannot read "${absPath}": ${(err as Error).message}`);
    }
    const sha256Hex = createHash("sha256").update(bytes).digest("hex");
    return { relPath, sha256Hex };
  });

  // Step 4: ascending BYTE order of the relative path string (not locale collation) — plain `<`
  // comparison on JS strings compares UTF-16 code units, which is byte order for the ASCII paths
  // this repo uses.
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  // Step 6: concatenate `${relPath}\n${sha256Hex}\n` for each file in order.
  const concatenated = entries.map((e) => `${e.relPath}\n${e.sha256Hex}\n`).join("");

  // Step 7: SHA-256 of that concatenation, hex.
  return createHash("sha256").update(concatenated, "utf-8").digest("hex");
}
