// Plan Report — specs/daily-catalyst-manual-trading.md §5.6a (normative layout, revision 3).
//
// Pure rendering only (verification gate §12.14): `renderPlanReport` takes an already-assembled
// `DailyDecision` plus that date's `DailyReport` and returns Markdown. `scripts/decide-daily.ts`
// is the only writer of the resulting `reports/<date>.decision.md` file (P9, gate §12.15).
//
// Spec-gap resolution: §5.6a's normative table requires "## 7. Other open positions" to list
// every OTHER open journal trade (tradeId, symbol, side, planId, today's manage artifact path),
// but `renderPlanReport`'s literal 2-arg signature (`decision`, `report`) carries neither the
// journal nor any other trade's symbol/side/planId — `DailyReport.openTradeThesis` only carries
// `{tradeId, ruleId, state, conditions}`. A third parameter, `otherOpenTrades`, supplies exactly
// the fields §5.6a's row needs; the CLI (which already loads the journal for validation) builds
// it by filtering out any trade whose `planId` equals this decision's own `plan.planId`.

import type { DailyDecision, OwnerProtocolOrder } from "./types.ts";
import type { DailyReport } from "../research/report.ts";

export interface OtherOpenTradeRow {
  tradeId: string;
  symbol: string;
  side: "long" | "short";
  planId: string | null;
}

const DISCLAIMER = "Generated analysis for the owner's review. Not investment advice.";

// ── time formatting (UTC + owner time zone, §13 A28) ────────────────────────────────────────────

function fmtUtc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function tzOffsetLabel(tz: string, ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(ms);
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC+0";
    return raw.replace("GMT", "UTC");
  } catch {
    return "UTC";
  }
}

function fmtInZone(ms: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(ms);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    return fmtUtc(ms);
  }
}

/** "<utc> UTC (<zone-local> <offset label>)" — every absolute instant is printed both ways (A28). */
function fmtBoth(ms: number, tz: string): string {
  return `${fmtUtc(ms)} (${fmtInZone(ms, tz)} ${tzOffsetLabel(tz, ms)})`;
}

/** "<from> UTC → <until> UTC (<from-zone> → <until-zone> <offset label>)". */
function fmtWindowBoth(fromMs: number, untilMs: number, tz: string): string {
  const utc = `${fmtUtc(fromMs)} → **${fmtUtc(untilMs)}**`;
  const zone = `${fmtInZone(fromMs, tz)} → ${fmtInZone(untilMs, tz)} ${tzOffsetLabel(tz, untilMs)}`;
  return `${utc} (${zone})`;
}

function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ── §1 order table ───────────────────────────────────────────────────────────────────────────

function orderRow(o: OwnerProtocolOrder, referencePrice: number): string {
  const label = o.kind === "entry" ? "Entry" : o.kind === "stop" ? "Stop loss" : "Take profit";
  const action = o.action.toUpperCase();
  const priceCell = o.price === null ? `~${fmtNum(referencePrice)} (reference)` : fmtNum(o.price);
  const reduceOnlyCell = o.reduceOnly ? "**yes**" : "no";
  return `| ${o.slot} | ${label} — ${action} | ${o.orderType} | ${priceCell} | ${fmtNum(o.quantity, 4)} | ${reduceOnlyCell} |`;
}

function renderSection1(decision: DailyDecision): string[] {
  const lines: string[] = ["## 1. Execute now — the orders you place by hand", ""];

  if (decision.plan === null || decision.ownerProtocol === null) {
    lines.push(`**No trade today.** ${decision.input.choice.kind === "no-trade" ? decision.input.choice.reason : ""}`);
    lines.push("");
    return lines;
  }

  const plan = decision.plan;
  const protocol = decision.ownerProtocol;
  const tz = protocol.ownerTimeZone;

  const venueLine = plan.venueIntent === "paper"
    ? "Venue **paper** — place nothing on Bybit; record it in the journal."
    : "Venue **live** — place these orders on Bybit for real, then link the filled position in the journal.";
  lines.push(`${venueLine} Margin mode: **isolated**. Leverage: **${protocol.leverage}x**. Quantity: **${fmtNum(plan.quantity, 6)} ${plan.symbol.split("/")[0]}** (notional $${fmtNum(plan.notionalUsd)}, margin $${fmtNum(plan.marginUsd)}).`);
  lines.push("");
  lines.push("| # | Order | Type | Price | Quantity | Reduce-only |");
  lines.push("|---|-------|------|-------|----------|-------------|");
  for (const o of protocol.orders) lines.push(orderRow(o, plan.referencePrice));
  lines.push("");
  lines.push(
    `Risk if stopped: **$${fmtNum(plan.riskUsd)}**. Est. round-trip fee: $${fmtNum(plan.estRoundTripFeeUsd, 3)}. ` +
    `Est. liquidation ${fmtNum(plan.estLiquidationPrice)} — ${fmtNum(plan.liqToStopRatio)}× the stop distance away.`,
  );
  lines.push("");
  lines.push(`**Execute window:** ${fmtWindowBoth(protocol.executeFrom, protocol.executeUntil, tz)}. After it closes, do not enter: wait for tomorrow's report.`);
  lines.push(
    `**Gap rule:** do not enter if the mark is more than **${fmtNum(protocol.maxEntryGapAbs)}** away from ${fmtNum(protocol.referencePrice)} ` +
    `(${fmtNum(protocol.maxEntryGapAbs / protocol.atr14d, 2)} × ATR14d ${fmtNum(protocol.atr14d)}) — i.e. outside ` +
    `**${fmtNum(protocol.entryBand[0])} – ${fmtNum(protocol.entryBand[1])}**. If it is outside, do not enter.`,
  );
  if (protocol.recordVia === "paper-api") {
    lines.push(`**Record it:** paper → \`npm run journal\` → \`POST /api/paper/entry {"planId":"${plan.planId}","fillPrice":<your fill>,"time":<ms>}\`.`);
  } else {
    lines.push(`**Record it:** live → start \`npm run journal\` (it syncs on startup and every 30 s), then \`POST /api/trades/:id/link {"planId":"${plan.planId}"}\` for the synced position.`);
  }
  lines.push("");
  return lines;
}

// ── §2 come-back timeline ────────────────────────────────────────────────────────────────────

function renderSection2(decision: DailyDecision): string[] {
  const lines: string[] = ["## 2. When to come back", "", "| When | You do | Then |", "|------|--------|------|"];
  const decisionsRoot = "data/decisions";
  const dateUtc = decision.dateUtc;
  const managePathHint = `\`${decisionsRoot}/${dateUtc}.manage.<tradeId>.json\``;
  const reviewPathHint = `\`${decisionsRoot}/${dateUtc}.review.<tradeId>.json\``;

  lines.push(
    "| **Every day at 00:15 UTC (21:15 UTC−3 the evening before), after the timer has run** | " +
    "Read `reports/<date>.md`, then open the persona | It runs `manage open position` or `review closed trade` **once per trade** " +
    "and writes each call through `npm run decide` |",
  );

  const plan = decision.plan;
  const protocol = decision.ownerProtocol;
  if (plan !== null && protocol !== null) {
    const recordExit = plan.venueIntent === "paper"
      ? `Paper: record the exit the same day with \`POST /api/paper/exit {"tradeId":"<tradeId>","fillPrice":<price>,"time":<ms>,"exitKind":"stop"|"target"|"time"}\` (the journal has no exchange to see it).`
      : `Live: \`npm run journal\` syncs the exit automatically; check \`GET /api/state\` shows \`lastSync.status: "ok"\`.`;
    lines.push(
      `| **Position closed** — stop ${fmtNum(plan.stopPrice)} hit, target ${fmtNum(plan.targetPrice)} hit, or the time exit below | ` +
      `${recordExit} Then, at the **next** daily report, ask the persona to \`review closed trade\` for this trade | ${reviewPathHint} — R, exit kind, adherence, thesis verdict, lesson |`,
    );
    lines.push(
      `| **Position still open** at the next daily report | Ask the persona to \`manage open position\` for this trade | ${managePathHint} ` +
      `with exactly one of \`hold\` / \`tighten stop to <price>\` / \`close now\` — you execute it by hand that morning |`,
    );
    lines.push(
      `| **${new Date(protocol.timeExitOnOrBefore).toISOString().slice(0, 10)} (maxHoldDays ${plan.maxHoldDays}) — hard time exit** | ` +
      "Close the position yourself that day at whatever price it is | Record the exit with `exitKind: \"time\"` (paper: `POST /api/paper/exit`; live: the sync picks it up, you set the exit kind in the dashboard) |",
    );
  } else {
    lines.push(
      "| **Position closed** (an earlier open trade) | Paper: record the exit the same day with `POST /api/paper/exit` (`exitKind` stop / target / time); live: `npm run journal` syncs it. Then `review closed trade` at the next report | " + reviewPathHint + " |",
    );
    lines.push(
      "| **Position still open** (an earlier open trade) | `manage open position` for that trade at the next report | " + managePathHint + " |",
    );
    lines.push("| **Hard time exit** (an earlier open trade's own `maxHoldDays`) | Close it yourself that day | Record the exit with `exitKind: \"time\"` |");
  }

  lines.push(
    "| **Intraday, any time** | Nothing. The **journal dashboard**'s **alerts only** — no persona session between daily reports | Nothing to run |",
  );
  lines.push("");
  lines.push("(`<tradeId>` is filled in once you record the entry; until then the journal has no id for this plan.)");
  lines.push("");
  return lines;
}

// ── §3 rationale ─────────────────────────────────────────────────────────────────────────────

function renderSection3(decision: DailyDecision): string[] {
  const lines = ["## 3. Why this plan", "", decision.input.rationale];
  if (decision.input.choice.kind === "persona-idea") {
    const idea = decision.input.choice.idea;
    lines.push("");
    lines.push(`Thesis: ${idea.thesis}`);
    if (idea.catalysts.length > 0) lines.push(`Catalysts: ${idea.catalysts.join("; ")}`);
    if (idea.invalidateWhenAny.length > 0) {
      lines.push(`Invalidates when any of: ${idea.invalidateWhenAny.map((c) => `${c.feature} ${c.op} ${Array.isArray(c.value) ? c.value.join("..") : c.value}`).join("; ")}`);
    }
  }
  lines.push("");
  return lines;
}

// ── §4 stances ───────────────────────────────────────────────────────────────────────────────

function renderSection4(decision: DailyDecision, report: DailyReport): string[] {
  const lines = [
    "## 4. Stances on every plan in today's report", "",
    "| planId | channel | stance | reasons |", "|--------|---------|--------|---------|",
  ];
  const planById = new Map(report.plans.filter((p) => p.kind === "plan").map((p) => [p.planId, p]));
  for (const stance of decision.input.stances) {
    const plan = planById.get(stance.planId);
    const channel = plan ? plan.origin : "?";
    const chosen = stance.planId === decision.basedOnPlanId ? " ← chosen" : "";
    lines.push(`| \`${stance.planId}\`${chosen} | ${channel} | ${stance.stance} | ${escapeCell(stance.reasons.join("; "))} |`);
  }
  lines.push("");
  return lines;
}

// ── §5 news ──────────────────────────────────────────────────────────────────────────────────

function renderSection5(decision: DailyDecision): string[] {
  if (decision.input.news.length === 0) return ["## 5. News checked", "", "News: not checked", ""];
  const lines = ["## 5. News checked", "", "| title | url | date | tag |", "|-------|-----|------|-----|"];
  for (const item of decision.input.news) {
    lines.push(`| ${escapeCell(item.title)} | ${item.url} | ${item.date ?? "-"} | ${item.tag} |`);
  }
  lines.push("");
  return lines;
}

// ── §6 unverified ────────────────────────────────────────────────────────────────────────────

function renderSection6(decision: DailyDecision): string[] {
  const lines = ["## 6. Not verified by the system", ""];
  if (decision.validation.unverifiedWebRefs.length === 0) {
    lines.push("None.");
  } else {
    for (const ref of decision.validation.unverifiedWebRefs) {
      lines.push(`- web ref \`${ref.url}\` — persona search result, **unverified** (the system does not capture the persona's searches).`);
    }
  }
  lines.push("");
  return lines;
}

// ── §7 other open positions ──────────────────────────────────────────────────────────────────

function renderSection7(decision: DailyDecision, otherOpenTrades: readonly OtherOpenTradeRow[]): string[] {
  const lines = ["## 7. Other open positions", ""];
  if (otherOpenTrades.length === 0) {
    lines.push("None.");
    lines.push("");
    return lines;
  }
  lines.push(
    "These are **not** governed by this page — each has its own Plan Report and its own per-trade artifact today:",
    "",
    "| tradeId | symbol | side | planId | Today's manage artifact |",
    "|---------|--------|------|--------|-------------------------|",
  );
  for (const t of otherOpenTrades) {
    lines.push(`| \`${t.tradeId}\` | ${t.symbol} | ${t.side} | \`${t.planId ?? "-"}\` | \`data/decisions/${decision.dateUtc}.manage.${t.tradeId}.json\` |`);
  }
  lines.push("");
  return lines;
}

/** Pure. Renders §5.6a's layout. Every dynamic string is escaped for Markdown table cells
 *  (`|` -> `\|`); every absolute time is printed twice, `<UTC> UTC` and the same instant in
 *  `ownerProtocol.ownerTimeZone`. See file header for the `otherOpenTrades` gap resolution. */
export function renderPlanReport(
  decision: DailyDecision,
  report: DailyReport,
  otherOpenTrades: readonly OtherOpenTradeRow[] = [],
): string {
  // Found on the first real no-trade run: `ownerProtocol` is null when there is no plan, and the
  // second clock column silently became UTC+0. The zone now travels on the decision itself.
  const tz = decision.ownerTimeZone ?? decision.ownerProtocol?.ownerTimeZone ?? "UTC";
  const lines: string[] = [];

  const plan = decision.plan;
  const headline = plan
    ? `**${plan.symbol} ${plan.side.toUpperCase()}** · channel \`persona\` (\`${plan.ruleId}\`, ${decision.personaRule?.status ?? "experimental"} → ${plan.venueIntent}) · decided ${fmtBoth(decision.decidedAt, tz)}`
    : `**No trade** · channel \`persona\` · decided ${fmtBoth(decision.decidedAt, tz)}`;

  lines.push(`# Plan Report — ${decision.dateUtc}`, "");
  lines.push(headline);
  const basedOnLine = decision.basedOnPlanId
    ? `Based on report plan \`${decision.basedOnPlanId}\` · `
    : "";
  lines.push(
    `${basedOnLine}report \`${decision.reportPath}\` (sha256 \`${decision.reportSha256.slice(0, 12)}…\`), ` +
    `decisionTime ${fmtUtc(decision.reportDecisionTime)}, completeness \`${report.completeness}\``,
  );
  lines.push("");

  lines.push(...renderSection1(decision));
  lines.push(...renderSection2(decision));
  lines.push(...renderSection3(decision));
  lines.push(...renderSection4(decision, report));
  lines.push(...renderSection5(decision));
  lines.push(...renderSection6(decision));
  lines.push(...renderSection7(decision, otherOpenTrades));

  lines.push(DISCLAIMER);
  lines.push("");

  return lines.join("\n");
}
