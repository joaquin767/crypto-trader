// Journal server — specs/daily-catalyst-manual-trading.md §5.12 (endpoints/errors), §5.8a
// (server hardening: read-only key assertion, Host/Origin checks, paper-only mode, sync loop).
//
// Separate entrypoint from src/server/index.ts / src/main.ts (§4.14) — this never imports the
// auto-trader. `createJournalApp` builds a Hono app + mutable state from injected deps so HTTP
// behavior is testable with `app.request(...)` without binding a port; `startJournalServer`
// does the real read-only-key check and binds `127.0.0.1:journalPort`; `main` wires real deps
// (config, RestClient, the public-kline HTTP helper) and calls it.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";

import type { Config, ManualTradingConfig } from "../config.ts";
import { loadConfig, resolveManualTradingConfig } from "../config.ts";
import { RestClient } from "../bybit/rest.ts";
import { appSymbolToBybit } from "../bybit/adapters.ts";
import { assertReadOnlyKey, syncFromExchange, TradePermissionKeyError } from "../journal/exchange-sync.ts";
import type { SyncResult } from "../journal/exchange-sync.ts";
import {
  defaultSyncStatusPath, linkTradeToPlan, loadManualJournal, recordPaperEntry, recordPaperExit,
  saveManualJournal, writeSyncStatus,
} from "../journal/manual-journal.ts";
import type { ExitKind, ManualTrade } from "../journal/types.ts";
import { computeBreaker } from "../journal/breaker.ts";
import type { BreakerConfig } from "../journal/breaker.ts";
import { aggregate, liveView, reviewClosedTrade } from "../journal/trade-analytics.ts";
import type { LiveTradeView } from "../journal/trade-analytics.ts";
import { buildTradeChartData, chooseInterval, INTERVAL_MS } from "../journal/chart.ts";
import type { ChartInterval, TradeChartData } from "../journal/chart.ts";
import { fetchKlines as fetchKlinesPublic, splitFormingCandle } from "../journal/market-data.ts";
import { defaultAdapterDeps } from "../research/http.ts";
import type { ThesisState } from "../research/rules.ts";
import type { DailyReport } from "../research/report.ts";
import type { TradePlan } from "../research/planner.ts";
import type { Kline } from "../research/types.ts";
import type { AiStance } from "../research/ai/types.ts";
import { dateFromPlanId, loadEffectiveDecision } from "../decision/decisions-store.ts";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "../risk/circuit-breaker.ts";

const DAILY_LOOKBACK_DAYS = 15; // enough calendar days to have >= 8 daily bars before any entry

const HOUR_MS = 60 * 60 * 1000;

// ── Report lookup (for linking and open-trade thesis) ──────────────────────────────────────────

/** The highest-revision report for the highest date found under `reportsRoot`, or null. Report
 *  file names are `YYYY-MM-DD.json` / `YYYY-MM-DD.rN.json` (scripts/research-daily.ts). */
export function latestReport(reportsRoot: string): DailyReport | null {
  if (!existsSync(reportsRoot)) return null;
  const re = /^(\d{4}-\d{2}-\d{2})(?:\.r(\d+))?\.json$/;
  let best: { date: string; revision: number; file: string } | null = null;
  for (const file of readdirSync(reportsRoot)) {
    const m = re.exec(file);
    if (!m) continue;
    const date = m[1]!;
    const revision = m[2] ? Number.parseInt(m[2], 10) : 0;
    if (!best || date > best.date || (date === best.date && revision > best.revision)) {
      best = { date, revision, file };
    }
  }
  if (!best) return null;
  return JSON.parse(readFileSync(join(reportsRoot, best.file), "utf-8")) as DailyReport;
}

/** planId = `${dateUtc}:${ruleId}:${symbol}` (§5.5) — the date prefix names the report file. */
/** Paper exits the owner can record; liquidation/unknown only come from exchange data. */
const PAPER_EXIT_KINDS = new Set<string>(["stop", "target", "time", "thesis_invalidated", "discretionary"]);
/** How far a paper entry/exit timestamp may be from the server clock (clock skew, slow form). */
export const PAPER_TIME_TOLERANCE_MS = 5 * 60_000;

function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function paperTimeError(time: number, now: number): string | null {
  if (!Number.isFinite(time) || Math.abs(time - now) > PAPER_TIME_TOLERANCE_MS) {
    return "paper trades must be recorded when they happen (time within 5 minutes of now) — backdating would let hindsight into Gate D1";
  }
  return null;
}

function reportForPlanId(reportsRoot: string, planId: string): DailyReport | null {
  const date = planId.split(":")[0] ?? "";
  // planId is request input: only a strict YYYY-MM-DD may reach the RegExp below, otherwise
  // ".*" would match every report and "(" would throw.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const re = new RegExp(`^${date}(?:\\.r(\\d+))?\\.json$`);
  let best: { revision: number; file: string } | null = null;
  if (!existsSync(reportsRoot)) return null;
  for (const file of readdirSync(reportsRoot)) {
    const m = re.exec(file);
    if (!m) continue;
    const revision = m[1] ? Number.parseInt(m[1], 10) : 0;
    if (!best || revision > best.revision) best = { revision, file };
  }
  if (!best) return null;
  return JSON.parse(readFileSync(join(reportsRoot, best.file), "utf-8")) as DailyReport;
}

function findPlan(report: DailyReport, planId: string): Extract<TradePlan, { kind: "plan" }> | null {
  const plan = report.plans.find((p) => p.kind === "plan" && p.planId === planId);
  return (plan as Extract<TradePlan, { kind: "plan" }> | undefined) ?? null;
}

// ── Revision 3: persona planId resolution from data/decisions/ (§5.8a revision-3 paragraph) ────
//
// A `persona-*` planId is never in any report — it names a decision the CLI wrote to
// data/decisions/<date>.json, so it is resolved there instead, and its entry window is the
// decision's own execute window (decidedAt -> ownerProtocol.executeUntil), not the report's 12h
// expiresAt.

/** planId = `${dateUtc}:${ruleId}:${symbol}` (§5.5) — a persona-origin ruleId always looks like
 *  `persona-<hash8>`. */
function planIdIsPersona(planId: string): boolean {
  const middle = planId.split(":")[1];
  return typeof middle === "string" && middle.startsWith("persona-");
}

interface ResolvedPersonaPlan {
  plan: Extract<TradePlan, { kind: "plan" }>;
  windowFrom: number; // decision.decidedAt
  windowUntil: number; // decision.ownerProtocol.executeUntil
}

/** Loads the effective decision for the planId's date and matches its own `plan.planId`. Null
 *  when the decision file, its plan, or its owner protocol is absent (AC-117: 404 either way). */
function resolvePersonaPlan(decisionsRoot: string, planId: string): ResolvedPersonaPlan | null {
  const date = dateFromPlanId(planId);
  if (date === null) return null;
  const decision = loadEffectiveDecision(decisionsRoot, date);
  if (!decision || decision.plan === null || decision.plan.planId !== planId || decision.ownerProtocol === null) return null;
  return { plan: decision.plan, windowFrom: decision.decidedAt, windowUntil: decision.ownerProtocol.executeUntil };
}

// ── App factory ──────────────────────────────────────────────────────────────────────────────────

export interface JournalAppDeps {
  config: Config;
  manual: ManualTradingConfig;
  journalPath: string;
  reportsRoot: string;
  /** Revision 3 (§5.8a): root for `data/decisions/`, used to resolve a `persona-*` planId. */
  decisionsRoot: string;
  /** Revision 3 (§5.15): sidecar path `writeSyncStatus` writes after every sync attempt. */
  syncStatusPath: string;
  /** null => paper-only mode (no read-only key configured, or verification was skipped by the
   *  caller — `startJournalServer` is the one that enforces the AC-27 refusal-to-start rule). */
  rest: RestClient | null;
  now: () => number;
  /** Paged public klines (§5.14) for MAE/MFE reviews and the trade chart; null on any
   *  HTTP/shape/paging failure — never a partial series (P1, AC-71). */
  fetchKlines: (symbol: string, interval: ChartInterval | "D", startMs: number, endMs: number) => Promise<Kline[] | null>;
}

export interface JournalAppHandle {
  app: Hono;
  getState: () => { journal: ManualTrade[]; lastSync: SyncResult | null };
  /** Runs one sync cycle (no-op, `status: "failed"` result, in paper-only mode) and persists the
   *  resulting journal. Exposed so `main`'s interval and tests can both drive it deterministically. */
  syncOnce: () => Promise<SyncResult>;
}

function breakerConfigFrom(deps: JournalAppDeps): BreakerConfig {
  const c = deps.config;
  return {
    maxDailyLossPercent: c.maxDailyLossPercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDailyLossPercent,
    maxDrawdownHaltPercent: c.maxDrawdownHaltPercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDrawdownHaltPercent,
    maxConsecutiveLosses: c.maxConsecutiveLosses ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxConsecutiveLosses,
    maxSlippagePercent: c.maxSlippagePercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxSlippagePercent,
    breakerResetAt: deps.manual.breakerResetAt === null ? null : Date.parse(deps.manual.breakerResetAt),
  };
}

function thesisFor(report: DailyReport | null, tradeId: string): ThesisState {
  const entry = report?.openTradeThesis.find((t) => t.tradeId === tradeId);
  return entry?.state ?? "not_evaluable";
}

export function createJournalApp(deps: JournalAppDeps): JournalAppHandle {
  // A corrupt, unrecoverable journal (JournalUnreadableError) propagates to the caller —
  // startJournalServer/main refuse to start rather than silently running against an empty
  // journal (P1, mirrors research:daily's exit 5).
  let journal: ManualTrade[] = loadManualJournal({ path: deps.journalPath });
  let lastSync: SyncResult | null = null;
  const sseClients = new Set<{ write: (data: string) => void }>();

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(payload);
  }

  function persist(): void {
    saveManualJournal(journal, { path: deps.journalPath });
  }

  async function syncOnce(): Promise<SyncResult> {
    if (deps.rest === null) {
      lastSync = {
        syncedAt: deps.now(), status: "failed", error: "paper-only mode: no read-only key configured",
        newFills: 0, positions: [], warnings: [],
      };
      writeSyncStatus(
        { syncedAt: lastSync.syncedAt, status: lastSync.status, error: lastSync.error, liveSync: "disabled" },
        { path: deps.syncStatusPath },
      );
      return lastSync;
    }
    const journalStartTimeMs = deps.manual.journalStartTime === null ? null : Date.parse(deps.manual.journalStartTime);
    const { journal: next, result } = await syncFromExchange(
      journal, deps.rest, { symbols: deps.config.symbols, journalStartTime: journalStartTimeMs }, deps.now(),
    );
    journal = next;
    lastSync = result;
    if (result.status === "ok") {
      persist();
      broadcast("trade", { journal });
    }
    // Revision 3 sync-freshness sidecar (§5.15): written after EVERY sync attempt, ok or failed,
    // so `decide --revise` can tell a stale journal from a fresh one without a network call.
    writeSyncStatus(
      { syncedAt: result.syncedAt, status: result.status, error: result.error, liveSync: "enabled" },
      { path: deps.syncStatusPath },
    );
    broadcast("live", result);
    return result;
  }

  // Closed-trade reviews are recomputed for /api/review and again for every /api/stats call; each needs
  // a kline fetch, so successful reviews are cached by tradeId + updatedAt (failures are not cached).
  const reviewCache = new Map<string, { updatedAt: number; value: { review: ReturnType<typeof reviewClosedTrade>; maeMfeAvailable: boolean } }>();

  async function reviewOne(t: ManualTrade): Promise<{ review: ReturnType<typeof reviewClosedTrade>; maeMfeAvailable: boolean }> {
    const cached = reviewCache.get(t.id);
    if (cached && cached.updatedAt === t.updatedAt) return cached.value;
    const from = t.entryFills.reduce((min, f) => Math.min(min, f.time), Number.POSITIVE_INFINITY);
    const to = t.exitFills.reduce((max, f) => Math.max(max, f.time), 0);
    const klines = Number.isFinite(from) ? await deps.fetchKlines(t.symbol, "60", from, to) : null;
    const value = { review: reviewClosedTrade(t, klines ?? []), maeMfeAvailable: klines !== null };
    if (t.status === "closed" && klines !== null) reviewCache.set(t.id, { updatedAt: t.updatedAt, value });
    return value;
  }

  // ── Trade chart (§5.14) ──────────────────────────────────────────────────────────────────────
  // Closed trades never change once exited, so their chart is cached by tradeId + updatedAt;
  // open trades are always rebuilt (live mark price, forming candle).
  const chartCache = new Map<string, { updatedAt: number; data: TradeChartData }>();

  async function buildChartFor(t: ManualTrade): Promise<TradeChartData> {
    const entryTime = t.entryFills.reduce((min, f) => Math.min(min, f.time), Number.POSITIVE_INFINITY);
    const lastExit = t.exitFills.reduce((max, f) => Math.max(max, f.time), 0);
    const endBound = t.status === "closed" && lastExit > 0 ? lastExit : deps.now();
    const interval = chooseInterval(entryTime, endBound);
    const barMs = INTERVAL_MS[interval];
    const startMs = entryTime - 6 * barMs;
    const endMs = endBound + 6 * barMs;

    const rawCandles = await deps.fetchKlines(t.symbol, interval, startMs, endMs);
    const dataOk = rawCandles !== null;
    let candles = rawCandles ?? [];
    let formingCandle: Kline | null = null;
    if (dataOk && t.status === "open") {
      const split = splitFormingCandle(candles, interval, deps.now());
      candles = split.candles;
      formingCandle = split.formingCandle;
    }

    let dailyBars: Kline[] = [];
    if (dataOk) {
      const dailyStart = entryTime - DAILY_LOOKBACK_DAYS * INTERVAL_MS.D;
      dailyBars = (await deps.fetchKlines(t.symbol, "D", dailyStart, entryTime)) ?? [];
    }

    const stale = deps.now() - (lastSync?.syncedAt ?? 0) > deps.manual.staleAfterMs;
    const pos = lastSync?.positions.find((p) => p.symbol === t.symbol) ?? null;

    return buildTradeChartData(t, {
      candles, formingCandle, dailyBars,
      markPrice: stale ? null : pos?.markPrice ?? null,
      markStale: stale,
      now: deps.now(),
      interval,
      dataStatus: dataOk ? "ok" : "unavailable",
      dataDetail: dataOk ? "" : "kline data unavailable — the chart cannot be drawn right now",
    });
  }

  const app = new Hono();

  app.use("*", async (c, next) => {
    const port = deps.manual.journalPort;
    const host = c.req.header("host") ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return c.json({ error: "invalid Host header" }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        return c.json({ error: "invalid Origin header" }, 403);
      }
    }
    await next();
  });

  app.get("/", (c) => {
    const htmlPath = join(dirname(new URL(import.meta.url).pathname), "public", "journal.html");
    if (existsSync(htmlPath)) return c.html(readFileSync(htmlPath, "utf-8"));
    return c.text("Journal dashboard not found", 404);
  });

  app.get("/events", (c) => {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    writer.write(encoder.encode(`event: live\ndata: ${JSON.stringify(lastSync)}\n\n`)).catch(() => {});
    const client = { write: (data: string) => { writer.write(encoder.encode(data)).catch(() => {}); } };
    sseClients.add(client);
    const keepAlive = setInterval(() => { writer.write(encoder.encode(": keepalive\n\n")).catch(() => {}); }, 30_000);
    c.req.raw.signal?.addEventListener("abort", () => {
      sseClients.delete(client);
      clearInterval(keepAlive);
      writer.close().catch(() => {});
    }, { once: true });
    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  });

  app.get("/api/state", async (c) => {
    const breaker = computeBreaker(journal, breakerConfigFrom(deps), deps.config.maxCapitalUsd, deps.now());
    const report = latestReport(deps.reportsRoot);
    const openTrades = journal.filter((t) => t.status === "open");
    const openViews: LiveTradeView[] = openTrades.map((t) => {
      const pos = lastSync?.positions.find((p) => p.symbol === t.symbol) ?? null;
      const thesis = thesisFor(report, t.id);
      return liveView(t, pos, thesis, deps.now(), lastSync?.syncedAt ?? 0, deps.manual.staleAfterMs);
    });
    return c.json({
      liveSync: deps.rest === null ? "disabled" : "enabled",
      liveSyncReason: deps.rest === null ? "no read-only key configured (BYBIT_READONLY_API_KEY unset) — paper-only mode" : "",
      lastSync,
      fundingSignVerified: deps.manual.fundingSignVerified,
      breaker,
      openViews,
    });
  });

  app.get("/api/trades", (c) => {
    const venue = c.req.query("venue");
    const trades = venue ? journal.filter((t) => t.venue === venue) : journal;
    return c.json(trades);
  });

  app.get("/api/trades/:id/chart", async (c) => {
    const trade = journal.find((t) => t.id === c.req.param("id"));
    if (!trade) return c.json({ error: "unknown trade id" }, 404);

    if (trade.status === "closed") {
      const cached = chartCache.get(trade.id);
      if (cached && cached.updatedAt === trade.updatedAt) return c.json(cached.data);
    }

    const data = await buildChartFor(trade);
    // Never cache a failed fetch: a transient network error would otherwise pin "unavailable" forever.
    if (trade.status === "closed" && data.dataStatus === "ok") chartCache.set(trade.id, { updatedAt: trade.updatedAt, data });
    return c.json(data);
  });

  app.get("/api/review/:tradeId", async (c) => {
    const trade = journal.find((t) => t.id === c.req.param("tradeId"));
    if (!trade) return c.json({ error: "unknown trade id" }, 404);
    if (trade.status !== "closed") return c.json({ error: "trade is not closed" }, 409);
    const { review, maeMfeAvailable } = await reviewOne(trade);
    return c.json({ ...review, maeMfeAvailable, note: maeMfeAvailable ? undefined : "1h klines unavailable — MAE/MFE omitted, not guessed" });
  });

  app.get("/api/stats", async (c) => {
    const venue = c.req.query("venue") ?? "paper";
    const closed = journal.filter((t) => t.venue === venue && t.status === "closed")
      .sort((a, b) => lastExit(a) - lastExit(b));
    const reviews = await Promise.all(closed.map(async (t) => (await reviewOne(t)).review));
    const stats = aggregate(reviews, venue as ManualTrade["venue"]);
    // §8.4: "if, after >= 30 closed rule-origin trades per stance bucket,
    // byAiStance.oppose.expectancyR >= byAiStance.support.expectancyR, the dashboard shows
    // 'AI stance has no measured predictive value' on every AI stance." Not part of
    // AggregateStats itself (§5.9's exact contract) — computed here and added to the HTTP
    // response only, since it's a dashboard presentation flag, not an analytics figure.
    const { support, oppose } = stats.byAiStance;
    const aiStanceNoPredictiveValue =
      support.closed >= 30 && oppose.closed >= 30 &&
      support.expectancyR !== null && oppose.expectancyR !== null &&
      oppose.expectancyR >= support.expectancyR;
    return c.json({ ...stats, aiStanceNoPredictiveValue });
  });

  app.post("/api/trades/:id/link", async (c) => {
    const body = await safeJson(c);
    if (!body || typeof body.planId !== "string") return c.json({ error: "body must be { planId: string }" }, 400);
    const trade = journal.find((t) => t.id === c.req.param("id"));
    if (!trade) return c.json({ error: "unknown trade id" }, 404);

    let plan: Extract<TradePlan, { kind: "plan" }>;
    let windowFrom: number;
    let windowUntil: number;
    let aiStance: AiStance | null;

    // Revision 3: a persona-* planId is never looked up in reports/<date>.json (AC-117) — it is
    // resolved from data/decisions/ and its window is the decision's own execute window.
    if (planIdIsPersona(body.planId)) {
      const resolved = resolvePersonaPlan(deps.decisionsRoot, body.planId);
      if (!resolved) return c.json({ error: "unknown plan id" }, 404);
      plan = resolved.plan;
      windowFrom = resolved.windowFrom;
      windowUntil = resolved.windowUntil;
      aiStance = null; // the batch AI channel never assesses a persona plan
    } else {
      const report = reportForPlanId(deps.reportsRoot, body.planId);
      const foundPlan = report ? findPlan(report, body.planId) : null;
      if (!report || !foundPlan) return c.json({ error: "unknown plan id" }, 409);
      plan = foundPlan;
      windowFrom = report.decisionTime;
      windowUntil = foundPlan.expiresAt;
      aiStance = report.aiAnalyst.assessments.find((a) => a.planId === foundPlan.planId)?.stance ?? null;
    }

    const firstEntry = trade.entryFills.reduce((min, f) => Math.min(min, f.time), Number.POSITIVE_INFINITY);
    if (
      plan.symbol !== trade.symbol || plan.side !== trade.side ||
      !(firstEntry >= windowFrom && firstEntry <= windowUntil)
    ) {
      return c.json({ error: "plan does not match this trade (symbol/side/entry-time window)" }, 409);
    }

    const alreadyLinked = journal.find((t) => t.id !== trade.id && t.planId === plan.planId);
    if (alreadyLinked) {
      return c.json({ error: `plan ${plan.planId} is already linked to trade ${alreadyLinked.id}` }, 409);
    }

    const updated = linkTradeToPlan(trade, plan, aiStance, deps.now());
    journal = journal.map((t) => (t.id === updated.id ? updated : t));
    persist();
    broadcast("trade", { journal });
    return c.json(updated);
  });

  app.post("/api/paper/entry", async (c) => {
    const body = await safeJson(c);
    if (!body || typeof body.planId !== "string" || !isPositiveFinite(body.fillPrice) || typeof body.time !== "number") {
      return c.json({ error: "body must be { planId: string; fillPrice: number > 0; time: number }" }, 400);
    }

    let plan: Extract<TradePlan, { kind: "plan" }>;
    let windowFrom: number;
    let windowUntil: number;
    let aiStance: AiStance | null;

    if (planIdIsPersona(body.planId)) {
      const resolved = resolvePersonaPlan(deps.decisionsRoot, body.planId);
      if (!resolved) return c.json({ error: "unknown plan id" }, 404);
      plan = resolved.plan;
      windowFrom = resolved.windowFrom;
      windowUntil = resolved.windowUntil;
      aiStance = null;
    } else {
      const report = reportForPlanId(deps.reportsRoot, body.planId);
      const foundPlan = report ? findPlan(report, body.planId) : null;
      if (!report || !foundPlan) return c.json({ error: "unknown plan id" }, 404);
      plan = foundPlan;
      windowFrom = report.decisionTime;
      windowUntil = foundPlan.expiresAt;
      aiStance = report.aiAnalyst.assessments.find((a) => a.planId === foundPlan.planId)?.stance ?? null;
    }

    // Paper results feed Gate D1, so they must be recorded as decisions happen: no backdating
    // (hindsight), only inside the plan's entry window, and one paper trade per plan.
    const timeError = paperTimeError(body.time, deps.now());
    if (timeError) return c.json({ error: timeError }, 409);
    if (body.time < windowFrom || body.time > windowUntil) {
      return c.json({ error: "paper entry time is outside the plan's entry window" }, 409);
    }
    const existing = journal.find((t) => t.planId === plan.planId);
    if (existing) return c.json({ error: `plan ${plan.planId} already has trade ${existing.id}` }, 409);

    const trade = recordPaperEntry(plan, aiStance, body.fillPrice, body.time);
    journal = [...journal, trade];
    persist();
    broadcast("trade", { journal });
    return c.json(trade);
  });

  app.post("/api/paper/exit", async (c) => {
    const body = await safeJson(c);
    if (
      !body || typeof body.tradeId !== "string" || !isPositiveFinite(body.fillPrice) ||
      typeof body.time !== "number" || typeof body.exitKind !== "string" || !PAPER_EXIT_KINDS.has(body.exitKind)
    ) {
      return c.json({ error: `body must be { tradeId; fillPrice > 0; time; exitKind: ${[...PAPER_EXIT_KINDS].join(" | ")} }` }, 400);
    }
    const trade = journal.find((t) => t.id === body.tradeId);
    if (!trade) return c.json({ error: "unknown trade id" }, 404);
    if (trade.venue !== "paper" || trade.status !== "open") return c.json({ error: "trade is not an open paper trade" }, 409);
    const timeError = paperTimeError(body.time, deps.now());
    if (timeError) return c.json({ error: timeError }, 409);
    const lastEntry = trade.entryFills.reduce((max, f) => Math.max(max, f.time), 0);
    if (body.time < lastEntry) return c.json({ error: "paper exit time is before the entry" }, 409);

    const updated = recordPaperExit(trade, body.fillPrice, body.time, body.exitKind as ExitKind);
    journal = journal.map((t) => (t.id === updated.id ? updated : t));
    persist();
    broadcast("trade", { journal });
    return c.json(updated);
  });

  app.patch("/api/trades/:id/notes", async (c) => {
    const body = await safeJson(c);
    if (!body || typeof body.notes !== "string") return c.json({ error: "body must be { notes: string }" }, 400);
    const trade = journal.find((t) => t.id === c.req.param("id"));
    if (!trade) return c.json({ error: "unknown trade id" }, 404);
    const updated: ManualTrade = { ...trade, notes: body.notes, updatedAt: deps.now() };
    journal = journal.map((t) => (t.id === updated.id ? updated : t));
    persist();
    return c.json(updated);
  });

  app.patch("/api/trades/:id/exit-kind", async (c) => {
    const body = await safeJson(c);
    if (!body || body.exitKind !== "thesis_invalidated") {
      return c.json({ error: 'body must be { exitKind: "thesis_invalidated" }' }, 400);
    }
    const trade = journal.find((t) => t.id === c.req.param("id"));
    if (!trade) return c.json({ error: "unknown trade id" }, 404);
    if (trade.status !== "closed" || trade.exitKind !== "discretionary") {
      return c.json({ error: "exit-kind override only allowed on a closed trade whose current exitKind is discretionary" }, 409);
    }
    const updated: ManualTrade = { ...trade, exitKind: "thesis_invalidated", updatedAt: deps.now() };
    journal = journal.map((t) => (t.id === updated.id ? updated : t));
    persist();
    broadcast("trade", { journal });
    return c.json(updated);
  });

  return { app, getState: () => ({ journal, lastSync }), syncOnce };
}

function lastExit(t: ManualTrade): number {
  return t.exitFills.reduce((max, f) => Math.max(max, f.time), 0);
}

async function safeJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// ── Startup (real key check + bind) ─────────────────────────────────────────────────────────────

/** Verifies a configured read-only key (AC-27: refuses to start on `TradePermissionKeyError` or
 *  a network failure), then binds `127.0.0.1:journalPort` (never `0.0.0.0`, AC-36) and starts the
 *  live-sync loop (skipped in paper-only mode). `server` (the underlying `net.Server`) is
 *  exposed so tests can assert on `server.address()` (AC-36) without a second bind. */
export async function startJournalServer(deps: JournalAppDeps): Promise<{ close: () => Promise<void>; server: import("node:net").Server }> {
  if (deps.rest !== null) {
    await assertReadOnlyKey(deps.rest); // throws TradePermissionKeyError — caller must not catch it away
  }

  const handle = createJournalApp(deps);
  const timer = deps.rest !== null
    ? setInterval(() => { handle.syncOnce().catch(() => {}); }, deps.manual.syncIntervalMs)
    : null;
  if (deps.rest !== null) await handle.syncOnce();

  const { serve } = await import("@hono/node-server");
  return new Promise((resolve) => {
    const server = serve({ fetch: handle.app.fetch, hostname: "127.0.0.1", port: deps.manual.journalPort }, () => {
      console.log(`[journal] listening on http://127.0.0.1:${deps.manual.journalPort}`);
      resolve({
        server: server as unknown as import("node:net").Server,
        close: async () => {
          if (timer) clearInterval(timer);
          server.close();
        },
      });
    });
  });
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const configPath = flagValue(argv, "--config") ?? "./config.json";
  const journalPath = flagValue(argv, "--journal-path") ?? "./manual-journal.json";
  const reportsRoot = flagValue(argv, "--reports-root") ?? "reports";
  const decisionsRoot = flagValue(argv, "--decisions-root") ?? "data/decisions";
  const syncStatusPath = flagValue(argv, "--sync-status-path") ?? defaultSyncStatusPath(journalPath);

  const config = loadConfig(configPath);
  const manual = resolveManualTradingConfig(config);

  const apiKey = process.env["BYBIT_READONLY_API_KEY"];
  const apiSecret = process.env["BYBIT_READONLY_API_SECRET"];
  const rest = apiKey && apiSecret
    ? new RestClient({
        apiKey, apiSecret, testnet: false,
        symbols: config.symbols.map(appSymbolToBybit),
        wsPingIntervalMs: 20_000, maxRetries: 5,
      })
    : null;

  const { fetch: publicFetch, sleep: publicSleep } = defaultAdapterDeps();
  const publicMarketDataDeps = { fetch: publicFetch, sleep: publicSleep };
  try {
    await startJournalServer({
      config, manual, journalPath, reportsRoot, decisionsRoot, syncStatusPath, rest,
      now: () => Date.now(),
      fetchKlines: (symbol, interval, startMs, endMs) => fetchKlinesPublic(symbol, interval, startMs, endMs, publicMarketDataDeps),
    });
  } catch (err) {
    if (err instanceof TradePermissionKeyError) {
      console.error(`[journal] refusing to start: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
