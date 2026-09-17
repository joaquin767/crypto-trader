// AI usage/cost ledger — specs/daily-catalyst-manual-trading.md §5.13, §4.18, §10.2.
//
// data/ai-usage.jsonl is committed (audit trail, §10.2): one line per call attempt, appended —
// never rewritten. `monthToDateSpendUsd` is read before every call (runAiAnalyst's budget gate,
// §5.13); a line that fails to parse throws rather than being skipped (P1, fail closed — a
// corrupt ledger must never silently let the AI channel keep spending unchecked).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AiAnalystConfig } from "./types.ts";

export interface AiLedgerEntry {
  time: number;
  dateUtc: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; webSearchRequests: number };
  /** Real API spend — 0 under provider "claude-cli" (§5.13). `monthToDateSpendUsd` sums this
   *  field only, so the `monthlyBudgetUsd` gate never sees subscription-billed calls. */
  costUsd: number;
  /** The provider's own list-price estimate, informational only — never summed by
   *  `monthToDateSpendUsd`. Equal to `costUsd` for the anthropic-api adapter. */
  listCostUsd: number;
  resultKind: "ok" | "failed";
}

function isSameUtcMonth(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth();
}

/** Missing file -> 0. A line that isn't valid JSON, or lacks a numeric `time`/`costUsd`, throws
 *  (§5.13: "unparseable line -> throws") — never silently ignored. */
export function monthToDateSpendUsd(ledgerPath: string, now: number): number {
  if (!existsSync(ledgerPath)) return 0;
  const raw = readFileSync(ledgerPath, "utf-8");
  let total = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as Partial<AiLedgerEntry>;
    if (typeof entry.time !== "number" || typeof entry.costUsd !== "number") {
      throw new Error(`data/ai-usage.jsonl: line missing numeric "time"/"costUsd": ${line}`);
    }
    if (isSameUtcMonth(entry.time, now)) total += entry.costUsd;
  }
  return total;
}

/** Pricing fields come from AiAnalystConfig (§5.11); excluded from promptVersionHash because
 *  they never change the AI's output, only its accounted cost. */
export function estimateCallCostUsd(
  usage: { inputTokens: number; outputTokens: number; webSearchRequests: number },
  cfg: Pick<AiAnalystConfig, "inputUsdPerMTok" | "outputUsdPerMTok" | "webSearchUsdPerRequest">,
): number {
  return (
    (usage.inputTokens / 1_000_000) * cfg.inputUsdPerMTok +
    (usage.outputTokens / 1_000_000) * cfg.outputUsdPerMTok +
    usage.webSearchRequests * cfg.webSearchUsdPerRequest
  );
}

/** Appends one line; creates the ledger's parent directory if needed (a fresh checkout has no
 *  `data/` directory until the first snapshot or AI call). Never rewrites existing lines. */
export function appendLedgerLine(ledgerPath: string, entry: AiLedgerEntry): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
}
