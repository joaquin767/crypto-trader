// Manual journal store — specs/daily-catalyst-manual-trading.md §5.7.
//
// Durability pattern copied (not imported) from src/learning/journal.ts (E7): atomic write
// (temp file + rename) with 5 rotated backups, and a load path that falls back through those
// backups newest-first. Unlike the scalper's journal, failures here are never swallowed —
// P1 (fail closed): a corrupt file that can't be recovered from any backup throws
// `JournalUnreadableError` instead of silently starting from an empty journal, because that
// journal is what real trade sizing, linking and the circuit breaker are computed from.
//
// Storage format: a plain JSON array of `ManualTrade` (no wrapping envelope) — simpler than the
// scalper's `{trades, nextId}` shape because ManualTrade.id is a uuid assigned at creation, not
// an auto-incrementing counter that needs persisting alongside the array.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AiStance } from "../research/ai/types.ts";
import type { TradePlan } from "../research/planner.ts";
import type { ExitKind, Fill, ManualTrade } from "./types.ts";
import type { SyncResult } from "./exchange-sync.ts";

export type { ManualTrade, ManualTradeVenue, ExitKind, Fill } from "./types.ts";

const BACKUP_COUNT = 5;

export class JournalUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalUnreadableError";
  }
}

export function defaultManualJournalPath(): string {
  return join(process.cwd(), "manual-journal.json");
}

function backupPath(livePath: string, n: number): string {
  return `${livePath}.bak.${n}`;
}

/** Reads and parses one candidate file. Returns null (never throws) on a missing file, invalid
 *  JSON, or a shape that isn't a trade array — the caller decides what "null" means (missing vs.
 *  corrupt) based on which candidate it was. */
function tryReadTrades(path: string): ManualTrade[] | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(raw)) return null;
    return raw as ManualTrade[];
  } catch {
    return null;
  }
}

/** Falls back through `.bak.1..5` (newest first) when the live file is missing or unreadable.
 *  A genuinely missing live file (first run, or nothing journaled yet) returns `[]` — only a
 *  live file that exists but fails to parse triggers the backup search, and only when every
 *  backup also fails does this throw `JournalUnreadableError` (AC-35). */
export function loadManualJournal(opts?: { path?: string }): ManualTrade[] {
  const path = opts?.path ?? defaultManualJournalPath();
  if (!existsSync(path)) return [];

  const primary = tryReadTrades(path);
  if (primary !== null) return primary;

  for (let n = 1; n <= BACKUP_COUNT; n++) {
    const candidate = tryReadTrades(backupPath(path, n));
    if (candidate !== null) return candidate;
  }

  throw new JournalUnreadableError(
    `manual journal at "${path}" is corrupt and all ${BACKUP_COUNT} backups are missing or corrupt`,
  );
}

/** Atomic write (temp file + rename) with backup rotation, same shape as
 *  src/learning/journal.ts's persistJournal — rotate BEFORE overwriting the live file so a
 *  crash mid-rotation still leaves at least one older generation intact. */
export function saveManualJournal(trades: readonly ManualTrade[], opts?: { path?: string }): void {
  const live = opts?.path ?? defaultManualJournalPath();
  const tmp = `${live}.tmp`;

  writeFileSync(tmp, JSON.stringify(trades, null, 2));

  if (existsSync(live)) {
    const oldest = backupPath(live, BACKUP_COUNT);
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let n = BACKUP_COUNT - 1; n >= 1; n--) {
      const from = backupPath(live, n);
      if (existsSync(from)) renameSync(from, backupPath(live, n + 1));
    }
    renameSync(live, backupPath(live, 1));
  }

  renameSync(tmp, live);
}

/** Pure. Links an existing (typically `planId: null`, unplanned) trade to the plan that
 *  justifies it. Validation (symbol/side match, entry-time window, plan kind) is the caller's
 *  responsibility — see the journal server's `POST /api/trades/:id/link` handler (§5.8a), which
 *  returns 409 instead of calling this when a check fails. */
export function linkTradeToPlan(
  trade: ManualTrade,
  plan: Extract<TradePlan, { kind: "plan" }>,
  aiStance: AiStance | null,
  now: number,
): ManualTrade {
  return {
    ...trade,
    planId: plan.planId,
    ruleId: plan.ruleId,
    ruleHash: plan.ruleHash,
    plannedSnapshot: plan,
    aiStanceAtPlan: aiStance,
    updatedAt: now,
  };
}

/** The plan's own `estRoundTripFeeUsd` is `notionalUsd × roundTripFeePercent / 100` (§5.5), so
 *  the round-trip fee percent used at planning time is recoverable from the plan alone — this
 *  keeps recordPaperEntry/recordPaperExit's signature exactly as specified (§5.7, no separate
 *  config parameter) while still applying "same fee rule" (§5.8a) to the real fill price. */
function roundTripFeePercentOf(plan: Extract<TradePlan, { kind: "plan" }>): number {
  return plan.notionalUsd === 0 ? 0 : (plan.estRoundTripFeeUsd / plan.notionalUsd) * 100;
}

/** Pure. `recordPaperEntry`: quantity = plan quantity, one fill at `fillPrice`,
 *  `feeUsd = notional × roundTripFeePercent / 200` (§5.8a). */
export function recordPaperEntry(
  plan: Extract<TradePlan, { kind: "plan" }>,
  aiStance: AiStance | null,
  fillPrice: number,
  time: number,
): ManualTrade {
  const roundTripFeePercent = roundTripFeePercentOf(plan);
  const feeUsd = (plan.quantity * fillPrice * roundTripFeePercent) / 200;
  const fill: Fill = {
    execId: `paper:${plan.planId}:entry`,
    time, price: fillPrice, qty: plan.quantity, feeUsd,
    side: plan.side === "long" ? "buy" : "sell",
  };
  return {
    id: randomUUID(),
    venue: "paper",
    symbol: plan.symbol,
    side: plan.side,
    planId: plan.planId,
    ruleId: plan.ruleId,
    ruleHash: plan.ruleHash,
    plannedSnapshot: plan,
    aiStanceAtPlan: aiStance,
    entryFills: [fill],
    exitFills: [],
    actualLeverage: plan.leverage,
    exchangeLiqPrice: plan.estLiquidationPrice,
    fundingUsd: 0,
    status: "open",
    exitKind: null,
    notes: "",
    createdAt: time,
    updatedAt: time,
  };
}

// ── Sync-freshness sidecar (revision 3, §5.15) ──────────────────────────────────────────────────
//
// `manual-journal.json` itself carries no sync timestamp — `ManualTrade.updatedAt` is the only
// persisted time, and `SyncResult.syncedAt` otherwise lives only in the journal server's process
// memory (src/server/journal-server.ts). `decide` runs as a separate CLI and needs to know how
// fresh the journal is before treating "no journal event since X" as meaningful (`--revise`'s
// "already acted on" checks) — so the journal server writes this small sidecar after every sync
// attempt, and `decide` reads it. Declared here (not in src/decision/) because it lives next to
// the journal it describes; src/decision/ only reads it.

export interface JournalSyncStatus {
  syncedAt: number;
  status: SyncResult["status"];
  error: string | null;
  liveSync: "enabled" | "disabled";
}

/** "<journalPath minus .json>.sync.json", i.e. "./manual-journal.sync.json" by default (§5.15). */
export function defaultSyncStatusPath(journalPath?: string): string {
  const live = journalPath ?? defaultManualJournalPath();
  return live.endsWith(".json") ? `${live.slice(0, -".json".length)}.sync.json` : `${live}.sync.json`;
}

/** Missing file → null. Unparseable → throws (fail closed, §5.15: "never treated as fresh"). */
export function readSyncStatus(opts?: { path?: string }): JournalSyncStatus | null {
  const path = opts?.path ?? defaultSyncStatusPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as JournalSyncStatus;
}

/** Called by the journal server only, after every sync attempt (including the paper-only
 *  branch). Atomic write (temp + rename) so a reader never observes a half-written file. */
export function writeSyncStatus(s: JournalSyncStatus, opts?: { path?: string }): void {
  const path = opts?.path ?? defaultSyncStatusPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}

/** Pure. `recordPaperExit`: same fee rule as entry, owner-supplied `exitKind`; funding stays 0
 *  (paper trades never accrue real funding, §5.8a). */
export function recordPaperExit(trade: ManualTrade, fillPrice: number, time: number, exitKind: ExitKind): ManualTrade {
  const plan = trade.plannedSnapshot;
  const qty = plan ? plan.quantity : trade.entryFills.reduce((sum, f) => sum + f.qty, 0);
  const roundTripFeePercent = plan ? roundTripFeePercentOf(plan) : 0;
  const feeUsd = (qty * fillPrice * roundTripFeePercent) / 200;
  const fill: Fill = {
    execId: `paper:${trade.id}:exit:${trade.exitFills.length}`,
    time, price: fillPrice, qty, feeUsd,
    side: trade.side === "long" ? "sell" : "buy",
  };
  return {
    ...trade,
    exitFills: [...trade.exitFills, fill],
    status: "closed",
    exitKind,
    updatedAt: time,
  };
}
