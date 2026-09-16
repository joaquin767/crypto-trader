// Exchange sync — specs/daily-catalyst-manual-trading.md §5.8/§5.8a (normative).
//
// I/O lives only in `assertReadOnlyKey` and `syncFromExchange`; `reconstructTrades` and its
// helpers are pure so the reconstruction/classification logic (the hard part) is unit-testable
// without a fake network.
//
// Reconstruction design note (resolves an ambiguity the spec's prose leaves implicit): a normal
// re-sync only fetches executions from near the newest already-known fill (§5.8a "Sync start"),
// not full history, so `reconstructTrades` must CONTINUE a symbol's existing open trade (if any)
// and carry its already-closed trades through untouched, rather than rebuilding the whole symbol
// from a running quantity of 0 every time — doing the latter would misinterpret a resumed window
// as a fresh position. Concretely: executions already represented by a fill execId in `existing`
// are dropped before replay (this alone satisfies "fills are not duplicated", AC-58); an
// already-open trade for the symbol is spread-copied and extended in place, so its `planId`,
// `ruleId`, `notes` and any owner-set `exitKind` survive automatically; already-closed trades for
// the symbol are passed through byte-identical when no new execution for that symbol arrives.
//
// The "execution reduces an unseen position" case (§5.8a, AC-57) is decided from Bybit's own
// `closedSize` field, not from the fill's side: when no journal trade is open for the symbol,
// closedSize > 0 means the fill closed a position opened before journalStartTime. A side-based
// guess would misread a buy that closes an old short as a brand-new long.

import { randomUUID } from "node:crypto";

import { appSymbolToBybit, bybitSymbolToApp } from "../bybit/adapters.ts";
import type { RestClient } from "../bybit/rest.ts";
import { firstEntryTime, lastExitTime } from "./trade-analytics.ts";
import type { ExitKind, Fill, ManualTrade } from "./types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
export const POSITIONS_SETTLE_COIN = "USDT";

// ── Read-only key assertion (§5.8, AC-27) ──────────────────────────────────────────────────────

export class TradePermissionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradePermissionKeyError";
  }
}

/** Calls `rest.getApiKeyInfo()`; throws `TradePermissionKeyError` unless `readOnly === 1` and no
 *  `Withdraw` permission in any category. A network/API failure also throws (fail closed, P4) —
 *  the server must never start against a key it couldn't verify. */
export async function assertReadOnlyKey(rest: RestClient): Promise<void> {
  let info: { readOnly: 0 | 1; permissions: Record<string, string[]> };
  try {
    info = await rest.getApiKeyInfo();
  } catch (err) {
    throw new TradePermissionKeyError(
      `could not verify the Bybit API key's permissions — refusing to start (fail closed): ${(err as Error).message}`,
    );
  }
  const hasWithdraw = Object.values(info.permissions).some((perms) => perms.includes("Withdraw"));
  if (info.readOnly !== 1 || hasWithdraw) {
    throw new TradePermissionKeyError(
      `Bybit API key has trade or withdraw permission (readOnly=${info.readOnly}, withdraw=${hasWithdraw}) — ` +
      "the journal never holds a key that can place orders or move funds (P4)",
    );
  }
}

// ── Reconstruction (§5.8a) ──────────────────────────────────────────────────────────────────────

export interface RawExecution {
  execId: string;
  symbol: string; // app format, e.g. "BTC/USDT"
  side: "buy" | "sell";
  price: number;
  qty: number;
  feeUsd: number;
  time: number;
  execType: "Trade" | "BustTrade";
  /** Bybit `closedSize`: how much of this execution closed an existing position. The only
   *  data-level signal that a fill belongs to a position the journal never saw open. */
  closedSize: number;
}

function fillOf(exec: RawExecution): Fill {
  return { execId: exec.execId, time: exec.time, price: exec.price, qty: exec.qty, feeUsd: exec.feeUsd, side: exec.side };
}

function signedQtyOf(t: ManualTrade): number {
  const entryQty = t.entryFills.reduce((sum, f) => sum + f.qty, 0);
  const exitQty = t.exitFills.reduce((sum, f) => sum + f.qty, 0);
  const magnitude = entryQty - exitQty;
  return t.side === "long" ? magnitude : -magnitude;
}

function weightedAvgExit(fills: readonly Fill[]): number {
  const qty = fills.reduce((sum, f) => sum + f.qty, 0);
  if (qty === 0) return 0;
  return fills.reduce((sum, f) => sum + f.qty * f.price, 0) / qty;
}

/** Exit classification (bybit-live, on close), §5.8a, first match wins. An already owner-set
 *  `thesis_invalidated` is never overwritten by re-classification (callers only invoke this for
 *  a trade transitioning to closed for the first time, or one whose `exitKind` isn't that
 *  override — see `buildTradesForSymbol`). */
function classifyExitKind(trade: ManualTrade, hadBustTrade: boolean): ExitKind {
  if (hadBustTrade) return "liquidation";
  const plan = trade.plannedSnapshot;
  if (plan === null) return "unknown";

  const d = Math.abs(plan.referencePrice - plan.stopPrice);
  const avgExit = weightedAvgExit(trade.exitFills);
  const long = trade.side === "long";

  const nearStop = long ? avgExit <= plan.stopPrice + 0.25 * d : avgExit >= plan.stopPrice - 0.25 * d;
  if (nearStop) return "stop";

  const nearTarget = long ? avgExit >= plan.targetPrice - 0.25 * d : avgExit <= plan.targetPrice + 0.25 * d;
  if (nearTarget) return "target";

  const lastExit = lastExitTime(trade);
  if (lastExit >= firstEntryTime(trade) + plan.maxHoldDays * DAY_MS - HOUR_MS) return "time";

  return "discretionary";
}

function buildTradesForSymbol(
  symbol: string,
  execs: readonly RawExecution[],
  priorTrades: readonly ManualTrade[],
  now: number,
): { trades: ManualTrade[]; warning: string | null } {
  const existingExecIds = new Set(priorTrades.flatMap((t) => [...t.entryFills, ...t.exitFills].map((f) => f.execId)));
  const newExecs = execs
    .filter((e) => !existingExecIds.has(e.execId))
    .slice()
    .sort((a, b) => a.time - b.time || a.execId.localeCompare(b.execId));

  const openPrior = priorTrades.find((t) => t.status === "open") ?? null;
  const closedPrior = priorTrades.filter((t) => t.status === "closed");

  const trades: ManualTrade[] = [...closedPrior];
  let current: ManualTrade | null = openPrior
    ? { ...openPrior, entryFills: [...openPrior.entryFills], exitFills: [...openPrior.exitFills] }
    : null;
  let runningQty = openPrior ? signedQtyOf(openPrior) : 0;
  let currentHadBust = false;
  let warning: string | null = null;

  const openTrade = (exec: RawExecution): ManualTrade => ({
    id: randomUUID(), venue: "bybit-live", symbol, side: exec.side === "buy" ? "long" : "short",
    planId: null, ruleId: null, ruleHash: null, plannedSnapshot: null, aiStanceAtPlan: null,
    entryFills: [fillOf(exec)], exitFills: [],
    actualLeverage: null, exchangeLiqPrice: null, fundingUsd: 0,
    status: "open", exitKind: null, notes: "",
    createdAt: exec.time, updatedAt: now,
  });

  const closeCurrent = (): void => {
    if (current === null) return;
    current.status = "closed";
    current.exitKind = current.exitKind === "thesis_invalidated" ? current.exitKind : classifyExitKind(current, currentHadBust);
    current.updatedAt = now;
    trades.push(current);
    current = null;
    currentHadBust = false;
  };

  for (const rawExec of newExecs) {
    let exec = rawExec;

    // §5.8a / AC-57: with no journal trade open for this symbol, any closedSize > 0 closes a
    // position the journal never saw open (opened before journalStartTime). That part is not
    // journaled — nothing is guessed. A remainder beyond closedSize opened a new position and is
    // journaled as `<execId>:flip`, fee split pro rata.
    if (current === null && exec.closedSize > 1e-9) {
      warning = `${symbol}: execution ${exec.execId} closes a position opened before journalStartTime — that part is not journaled`;
      const remainderQty = exec.qty - exec.closedSize;
      if (remainderQty <= 1e-9) continue;
      exec = { ...exec, execId: `${exec.execId}:flip`, qty: remainderQty, feeUsd: exec.feeUsd * (remainderQty / exec.qty), closedSize: 0 };
    }

    const delta = exec.side === "buy" ? exec.qty : -exec.qty;

    if (current === null) {
      current = openTrade(exec);
      currentHadBust = exec.execType === "BustTrade";
      runningQty = delta;
      continue;
    }

    const prevQty = runningQty;
    const newQty = prevQty + delta;
    const crossesZero = prevQty !== 0 && newQty !== 0 && Math.sign(prevQty) !== Math.sign(newQty);

    if (crossesZero) {
      // Split: the closing part exits the current trade, the remainder opens a new one
      // (execId + ":flip"), fee split pro rata by quantity (§5.8a, AC-56).
      const closingQty = Math.abs(prevQty);
      const remainderQty = Math.abs(newQty);
      const totalQty = exec.qty;
      const closingFee = totalQty === 0 ? 0 : exec.feeUsd * (closingQty / totalQty);
      const remainderFee = exec.feeUsd - closingFee;

      current.exitFills.push({ execId: exec.execId, time: exec.time, price: exec.price, qty: closingQty, feeUsd: closingFee, side: exec.side });
      if (exec.execType === "BustTrade") currentHadBust = true;
      closeCurrent();

      current = openTrade({ ...exec, execId: `${exec.execId}:flip`, qty: remainderQty, feeUsd: remainderFee });
      currentHadBust = exec.execType === "BustTrade";
      runningQty = newQty;
      continue;
    }

    const growing = Math.abs(newQty) > Math.abs(prevQty);
    if (growing) {
      current.entryFills.push(fillOf(exec));
    } else {
      current.exitFills.push(fillOf(exec));
      if (exec.execType === "BustTrade") currentHadBust = true;
    }
    current.updatedAt = now;
    runningQty = newQty;

    if (Math.abs(newQty) <= 1e-9) {
      runningQty = 0;
      closeCurrent();
    }
  }

  if (current !== null) trades.push(current);
  return { trades, warning };
}

/** Pure. Rebuilds `bybit-live` trades for exactly `symbols` from `executions`, leaving every
 *  other journal entry (paper trades, and `bybit-live` trades for symbols outside `symbols`)
 *  untouched. See the file header for the incremental-resync design. */
export function reconstructTrades(
  executions: readonly RawExecution[],
  existing: readonly ManualTrade[],
  symbols: readonly string[],
  now: number,
): { journal: ManualTrade[]; warnings: string[] } {
  const warnings: string[] = [];
  const symbolSet = new Set(symbols);
  const untouched = existing.filter((t) => !(t.venue === "bybit-live" && symbolSet.has(t.symbol)));

  const rebuilt: ManualTrade[] = [];
  for (const symbol of symbols) {
    const execs = executions.filter((e) => e.symbol === symbol && (e.execType === "Trade" || e.execType === "BustTrade"));
    const priorForSymbol = existing.filter((t) => t.venue === "bybit-live" && t.symbol === symbol);
    if (execs.length === 0) {
      rebuilt.push(...priorForSymbol);
      continue;
    }
    const { trades, warning } = buildTradesForSymbol(symbol, execs, priorForSymbol, now);
    if (warning) warnings.push(warning);
    rebuilt.push(...trades);
  }

  return { journal: [...untouched, ...rebuilt], warnings };
}

// ── Full sync (§5.8/§5.8a) ──────────────────────────────────────────────────────────────────────

export interface SyncResult {
  syncedAt: number;
  status: "ok" | "failed";
  error: string | null;
  newFills: number;
  positions: { symbol: string; side: "long" | "short"; size: number; avgPrice: number; leverage: number; liqPrice: number; markPrice: number; unrealisedPnl: number }[];
  warnings: string[];
}

/** execTypes that move position size and are journaled. AdlTrade (auto-deleveraging) closes
 *  position size like a trade, so it is replayed as one. */
const POSITION_EXEC_TYPES = new Map<string, RawExecution["execType"]>([
  ["Trade", "Trade"],
  ["BustTrade", "BustTrade"],
  ["AdlTrade", "Trade"],
]);
/** execTypes that never change position size and are safe to ignore (funding is fetched separately). */
const IGNORED_EXEC_TYPES = new Set(["Funding"]);

type ParsedExecution =
  | { kind: "exec"; exec: RawExecution }
  | { kind: "ignored" }
  | { kind: "error"; detail: string };

/** Fail closed: an execution we cannot parse, or an execType we do not know how to replay
 *  (e.g. Settle, Delivery, BlockTrade, MovePosition), fails the whole sync instead of being
 *  dropped or silently treated as a trade — either would corrupt the reconstructed positions. */
function parseRawExecution(raw: unknown, appSymbol: string): ParsedExecution {
  const r = raw as Record<string, unknown>;
  const rawType = typeof r["execType"] === "string" ? r["execType"] : "";
  if (IGNORED_EXEC_TYPES.has(rawType)) return { kind: "ignored" };
  const execType = POSITION_EXEC_TYPES.get(rawType);
  const execId = typeof r["execId"] === "string" ? r["execId"] : "";
  if (execType === undefined) {
    return { kind: "error", detail: `${appSymbol}: unsupported execType "${rawType}" (execId ${execId || "?"})` };
  }
  const side = r["side"] === "Buy" ? "buy" as const : r["side"] === "Sell" ? "sell" as const : null;
  const price = Number(r["execPrice"]);
  const qty = Number(r["execQty"]);
  const feeUsd = Number(r["execFee"]);
  const time = Number(r["execTime"]);
  const closedSize = Number(r["closedSize"]);
  if (!execId || side === null || !Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0 ||
      !Number.isFinite(feeUsd) || !Number.isFinite(time) || !Number.isFinite(closedSize) || closedSize < 0) {
    return { kind: "error", detail: `${appSymbol}: unparseable execution (execId ${execId || "?"})` };
  }
  return { kind: "exec", exec: { execId, symbol: appSymbol, side, price, qty, feeUsd, time, execType, closedSize } };
}

/** Fetches every execution for one symbol in `[startTime, endTime]`, in ≤7-day windows with
 *  cursor paging within each window, deduped by execId (§5.8a). */
async function fetchAllExecutions(rest: RestClient, appSymbol: string, startTime: number, endTime: number): Promise<RawExecution[]> {
  const bybitSymbol = appSymbolToBybit(appSymbol);
  const seen = new Set<string>();
  const out: RawExecution[] = [];
  let windowStart = startTime;
  while (windowStart < endTime) {
    const windowEnd = Math.min(windowStart + SEVEN_DAYS_MS, endTime);
    let cursor: string | undefined;
    do {
      const page = await rest.getExecutions("linear", bybitSymbol, windowStart, windowEnd, cursor);
      for (const raw of page.list) {
        const parsed = parseRawExecution(raw, appSymbol);
        if (parsed.kind === "error") throw new Error(parsed.detail);
        if (parsed.kind === "exec" && !seen.has(parsed.exec.execId)) {
          seen.add(parsed.exec.execId);
          out.push(parsed.exec);
        }
      }
      cursor = page.nextPageCursor || undefined;
    } while (cursor);
    windowStart = windowEnd;
  }
  return out;
}

/** `[normal start, that trade's newest fill time − 1h]` union rule (§5.8a "Open trades are never
 *  orphaned"): a symbol with an open `bybit-live` trade is always fetched from at least that
 *  trade's newest fill − 1h, regardless of `journalStartTime`/`config.symbols` changes. */
function symbolStartTime(symbol: string, journalStartTimeMs: number, journal: readonly ManualTrade[]): number {
  const symbolTrades = journal.filter((t) => t.venue === "bybit-live" && t.symbol === symbol);
  const newestKnownFillTime = symbolTrades
    .flatMap((t) => [...t.entryFills, ...t.exitFills])
    .reduce((max, f) => Math.max(max, f.time), 0);
  const normalStart = Math.max(journalStartTimeMs, newestKnownFillTime - HOUR_MS);

  const openTrade = symbolTrades.find((t) => t.status === "open");
  if (!openTrade) return normalStart;
  const openNewestFillTime = [...openTrade.entryFills, ...openTrade.exitFills].reduce((max, f) => Math.max(max, f.time), 0);
  return Math.min(normalStart, openNewestFillTime - HOUR_MS);
}

async function fundingUsdForTrade(rest: RestClient, trade: ManualTrade, now: number): Promise<number> {
  const bybitSymbol = appSymbolToBybit(trade.symbol);
  const start = firstEntryTime(trade);
  const end = trade.status === "closed" ? lastExitTime(trade) : now;
  // Bybit's execution list spans at most 7 days per request and pages with a cursor, so the
  // holding period is walked in 7-day windows with full paging. A partial total would silently
  // misstate net P&L (P1), so an unparseable row fails the sync instead of being skipped.
  const seen = new Set<string>();
  let total = 0;
  let windowStart = start;
  while (windowStart <= end) {
    const windowEnd = Math.min(windowStart + SEVEN_DAYS_MS, end);
    let cursor: string | undefined;
    do {
      const page = await rest.getFundingExecutions("linear", bybitSymbol, windowStart, windowEnd, cursor);
      for (const raw of page.list) {
        const r = raw as Record<string, unknown>;
        const execId = typeof r["execId"] === "string" ? r["execId"] : "";
        const t = Number(r["execTime"]);
        const fee = Number(r["execFee"]);
        if (!execId || !Number.isFinite(t) || !Number.isFinite(fee)) {
          throw new Error(`${trade.symbol}: unparseable funding row (execId ${execId || "?"})`);
        }
        if (seen.has(execId) || t < start || t > end) continue;
        seen.add(execId);
        total += fee;
      }
      cursor = page.nextPageCursor || undefined;
    } while (cursor);
    if (windowEnd >= end) break;
    windowStart = windowEnd;
  }
  // §5.8a: fundingUsd = −Σ execFee of the funding-history rows.
  return -total;
}

function parsePositions(list: readonly unknown[]): SyncResult["positions"] {
  const out: SyncResult["positions"] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown>;
    const size = Number(r["size"]);
    if (!Number.isFinite(size) || size === 0) continue;
    out.push({
      symbol: bybitSymbolToApp(String(r["symbol"] ?? "")),
      side: r["side"] === "Sell" ? "short" : "long",
      size,
      avgPrice: Number(r["avgPrice"]),
      leverage: Number(r["leverage"]),
      liqPrice: Number(r["liqPrice"]),
      markPrice: Number(r["markPrice"]),
      unrealisedPnl: Number(r["unrealisedPnl"]),
    });
  }
  return out;
}

/** Fetches executions for `cfg.symbols ∪ open bybit-live trade symbols` from
 *  `max(journalStartTime, newest known fill time − 1h)` (or the open-trade floor, whichever is
 *  earlier) to `now`, reconstructs trades, sets `fundingUsd` per touched trade and reads
 *  positions. Any fetch error → `status: "failed"`, journal returned UNCHANGED (never partially
 *  updated). Never rejects (§5.8/§5.8a). */
export async function syncFromExchange(
  journal: ManualTrade[],
  rest: RestClient,
  cfg: { symbols: string[]; journalStartTime: number | null },
  now: number,
): Promise<{ journal: ManualTrade[]; result: SyncResult }> {
  if (cfg.journalStartTime === null) {
    return {
      journal,
      result: { syncedAt: now, status: "failed", error: "manual.journalStartTime not set", newFills: 0, positions: [], warnings: [] },
    };
  }

  try {
    const openLiveSymbols = [...new Set(journal.filter((t) => t.venue === "bybit-live" && t.status === "open").map((t) => t.symbol))];
    const fetchSymbols = [...new Set([...cfg.symbols, ...openLiveSymbols])];
    const warnings: string[] = [];
    for (const symbol of openLiveSymbols) {
      if (!cfg.symbols.includes(symbol)) warnings.push(`${symbol}: open journal trade but symbol not in config.symbols`);
    }

    const journalStartTimeMs = cfg.journalStartTime;
    const allExecutions: RawExecution[] = [];
    for (const symbol of fetchSymbols) {
      const start = symbolStartTime(symbol, journalStartTimeMs, journal);
      allExecutions.push(...await fetchAllExecutions(rest, symbol, start, now));
    }

    const { journal: reconstructed, warnings: reconstructWarnings } = reconstructTrades(allExecutions, journal, fetchSymbols, now);
    warnings.push(...reconstructWarnings);

    const withFunding = await Promise.all(reconstructed.map(async (t) => {
      if (t.venue !== "bybit-live" || !fetchSymbols.includes(t.symbol)) return t;
      const fundingUsd = await fundingUsdForTrade(rest, t, now);
      return { ...t, fundingUsd };
    }));

    // Bybit rejects an unfiltered linear position list (retCode 10001 "symbol or settleCoin"
    // required, observed against mainnet). Every journaled symbol is a USDT perpetual.
    const positionsRaw = await rest.getPositions("linear", undefined, POSITIONS_SETTLE_COIN);
    const positions = parsePositions(positionsRaw.list);

    const priorExecIds = new Set(journal.flatMap((t) => [...t.entryFills, ...t.exitFills].map((f) => f.execId)));
    const newFills = allExecutions.filter((e) => !priorExecIds.has(e.execId)).length;

    return {
      journal: withFunding,
      result: { syncedAt: now, status: "ok", error: null, newFills, positions, warnings },
    };
  } catch (err) {
    return {
      journal, // unchanged — never partially updated (§5.8a)
      result: { syncedAt: now, status: "failed", error: (err as Error).message, newFills: 0, positions: [], warnings: [] },
    };
  }
}

// Re-exported for tests/callers that need to mint a fresh id in the exact way this module does
// (e.g. constructing an unplanned fixture trade by hand).
export { randomUUID };
