// Read-only helpers for `data/decisions/` — shared by src/server/journal-server.ts,
// scripts/research-daily.ts and scripts/decide-daily.ts. Writing to `data/decisions/` happens
// ONLY in scripts/decide-daily.ts (P9; verification gate §12.15 greps for exactly this). This
// file only reads, so it carries none of the write-pattern hits gate §12.14 checks for.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DailyDecision } from "./types.ts";

/** Effective (highest-revision) `<decisionsRoot>/<date>(.rN).json` — deliberately excludes
 *  `<date>.manage.<tradeId>(.rN).json` / `<date>.review.<tradeId>(.rN).json`, whose extra
 *  `.manage.`/`.review.` segment never matches this regex. Missing directory/file or unparseable
 *  content -> null (never thrown): every caller treats an absent/unreadable decision as
 *  "not_evaluable" or "not found", never as a crash (§5.15, AC-118). */
export function loadEffectiveDecision(decisionsRoot: string, date: string): DailyDecision | null {
  if (!existsSync(decisionsRoot)) return null;
  const re = new RegExp(`^${date}(?:\\.r(\\d+))?\\.json$`);
  let best: { revision: number; file: string } | null = null;
  for (const file of readdirSync(decisionsRoot)) {
    const m = re.exec(file);
    if (!m) continue;
    const revision = m[1] ? Number.parseInt(m[1], 10) : 0;
    if (!best || revision > best.revision) best = { revision, file };
  }
  if (!best) return null;
  try {
    return JSON.parse(readFileSync(join(decisionsRoot, best.file), "utf-8")) as DailyDecision;
  } catch {
    return null;
  }
}

/** The date embedded in a `persona-*` planId (`${dateUtc}:persona-<hash8>:${symbol}`), or null
 *  if `planId` isn't shaped that way. */
export function dateFromPlanId(planId: string): string | null {
  const date = planId.split(":")[0] ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}
