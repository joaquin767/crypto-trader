# Daily Catalyst Strategy, Manual Execution & Trade Journal — Pivot Spec

> **Accepted** by the spec factory (rubric v2, score 20/24, 2 rounds for revision 2; revision 1 accepted
> 20/24 in 1 round). Round-1 findings (19/24) and all five round-2 weaknesses were fixed; the round-2
> fixes (open-trade counter, disable-reason contract, gate-reset field list, `aiIdeaToRule` fields,
> `RestClient.getApiKeyInfo` ownership, 429 AC) were applied after acceptance.
>
> **Accepted** by the spec factory (rubric v2, score 20/24, 2 rounds) — **Revision 3**. Round-1 (19/24) findings
> (per-trade manage/review keying, the shared `config.symbols` side effect, AC-112's fifth clause, per-trade Plan
> Report scope) and all six round-2 weaknesses (`thesis_mismatch` validation, honest test citations in §4.23,
> AC-99's split, typed `validateManage`/`validateReview`, exact `skillHash` file-set semantics, `--revise`
> sync-freshness) were fixed; the round-2 fixes were applied after acceptance.

Status: **Revision 2 — accepted spec. Phases 1–4 implemented; Phase 4b (AI analyst channel) implemented,
defaulting to the `claude-cli` provider (the owner's Claude subscription via the locally installed CLI, no
per-call API billing) with `anthropic-api` as the pay-as-you-go alternative (§4.15–4.19, §5.13, §6.8
AC-40..53/AC-40a..c all green; AC-54/AC-54a are the manual live-smoke checks and stay for the owner);
Phase 5 (interactive persona, §4.7) implemented as `.claude/skills/crypto-fundamental-analyst/SKILL.md` via
gentle-ai `skill-creator`, sharing `prompts/ai-analyst.md`; AC-39's mechanical half is covered by
`tests/persona-skill.test.ts`, its owner run stays manual.** Revision 2 adds the AI analyst channel (§4.15, §5.13, §6.8, §8.4) at
the owner's request: Claude participates in each daily recommendation.

Status: **Revision 3 — Phase 6 implemented (AC-116 manual pending).** Revision 3 makes the interactive persona (§4.7) the *decision layer* (§3 P9, §4.20–4.23,
§5.15, §6.9, §8.5, Phase 6): each day the persona picks today's plan from the report's rule plans, the
report's AI plans, or an idea of its own — or no trade — and a new CLI (`npm run decide`) validates that
choice, sizes it with the **existing** `planTrade`, and writes a committed decision artifact plus an
owner-facing **Plan Report** that says exactly what to place and exactly when to come back. It also narrows
`config.symbols` to `["BTC/USDT", "ETH/USDT"]` (owner requirement, §13 A27). Everything in revisions 1–2 stays
as written: the persona still never sets size, leverage or venue, and execution stays 100% manual (P4).

Owner (every module this spec creates or changes):
`src/research/` (new), `src/journal/` (new), `src/backtest-daily/` (new), `src/server/journal-server.ts` (new),
`src/server/public/journal.html` (new), `src/config.ts`, `src/strategy/walkforward.ts` (export-only change),
`scripts/research-daily.ts` (new), `scripts/backtest-daily.ts` (new), `scripts/backfill-history.ts` (new),
`research-rules.json` (new), `tests/research-*.test.ts`, `tests/journal-*.test.ts`, `tests/backtest-daily-*.test.ts` (new),
`src/research/ai/` (new), `prompts/ai-analyst.md` (new), `tests/ai-*.test.ts` (new),
`src/bybit/rest.ts` (additive only: new method `getApiKeyInfo(): Promise<{ readOnly: 0 | 1; permissions: Record<string, string[]> }>` wrapping `GET /v5/user/query-api`; no existing method changes, so the auto-trader is unaffected),
`.claude/skills/crypto-fundamental-analyst/SKILL.md` (new), `package.json` (scripts + 2 dependencies, §10.1),
`src/decision/` (new, revision 3), `scripts/decide-daily.ts` (new, revision 3), `tests/decision-*.test.ts` (new, revision 3),
`.claude/skills/crypto-fundamental-analyst/references/decision-protocol.md` (new, revision 3) and edits to that skill's
`SKILL.md` (revision 3, §4.23); revision 3 also edits, additively, `src/config.ts` (`persona` block), `src/research/rules.ts`
and `src/research/planner.ts` (the `PlanOrigin` union and two optional provenance fields — `planTrade`'s body is unchanged),
`src/journal/trade-analytics.ts` (`byOrigin.persona`, `chosenByPersona`, `ClosedTradeReview.basedOnRuleKey`),
`src/server/journal-server.ts` (resolving a `persona-*` `planId`), `src/research/report.ts` (persona thesis loading),
`config.json` + `research-rules.json` (symbols) and `package.json` (the `decide` script).

Purpose: the 5-minute auto-trading strategy has a confirmed negative edge. This spec replaces it —
as the *thing the owner acts on* — with a once-per-day, catalyst/fundamental-informed system on
Bybit linear perpetuals. Two channels produce recommendations from the same point-in-time data: a
deterministic **rules channel** and an **AI analyst channel** (Claude, via the Anthropic API) that
assesses every rule plan and may propose its own ideas. **A human reads the combined report and places
every order by hand**, and a journal dashboard tracks each trade during and after its life. It also
introduces leverage, which the current system deliberately forbids, and gates both channels behind
measured edge — each channel is measured separately, so the owner learns whether the AI adds value.

---

## 0. How to read this document

- **§1** goal and operating context. **§2** evidence that motivates the pivot and constrains the design.
- **§3** design principles — every later section is checked against them.
- **§4** architecture and decomposition. **§5** public interface (typed contract).
- **§6** acceptance criteria. **§7** error & edge behavior (fail-closed table).
- **§8** validation gates D0/D1 — the only path to real capital and to leverage > 1x.
- **§9** severity-tiered, phased plan with the go/no-go sentence.
- **§10–§14** constraints, out of scope, verification, assumptions, considered alternatives.
- **Revision 3 (persona decision channel)** is concentrated in: §3 P9, §4.20–4.23, §5.6a (the owner-facing
  **Plan Report**, including the come-back timeline), §5.15 (the typed contract and the fail-closed
  validation table), §6.9 (AC-98..AC-118), §7's persona rows, §8.5 (gating) and Phase 6 in §9. Read §5.6a
  first if what you need is "what do I place, and when do I come back".

Severity tiers (same scheme as `specs/profit-target-roadmap.md:48-54`):

- **P0 — blocks real capital.** Without it, numbers are unfalsifiable or downside is unbounded.
- **P1 — blocks diagnosing or scaling.**
- **P2 — hardening.**
- **P3 — improvement.**

---

## 1. Goal

**Each day at 00:15 UTC, a CLI (`npm run research:daily`) snapshots a fixed set of free fundamental
and catalyst data sources, evaluates a user-authored, versioned rule set against that point-in-time
snapshot, and writes a daily report (`reports/YYYY-MM-DD.{json,md}`) listing which rules triggered,
the evidence, and a fully computed trade plan (side, entry zone, stop, target, size, leverage,
liquidation buffer). The owner reads the report, decides, and places orders manually on Bybit. A
separate dashboard (`npm run journal`, port 3082) imports the owner's real fills read-only from Bybit,
links them to the plan that justified them, and shows live risk during the trade and a planned-vs-actual
review after it.** In the same run, the **AI analyst** (Claude `claude-opus-5` via the Anthropic API)
receives that day's snapshot, rule outcomes, rule plans and open trades; it returns a schema-validated
assessment of each rule plan (support / caution / oppose, with verifiable evidence), notes on open
trades, and up to 3 ideas of its own, which the system verifies and sizes with the same planner. The
report shows both channels side by side; the owner decides. Rules only produce plans for real capital
after they pass Gate D0 (historical holdout) and Gate D1 (forward paper); AI ideas only after Gate D1
in its forward-only form (§8.4).

**Revision 3 adds the decision layer.** After the report exists, the owner opens the interactive persona
(§4.7) and asks for today's decision. The persona reads the report, checks news under its own protocol, and
chooses exactly one of: a `kind:"plan"` plan from the report's rules channel, a `kind:"plan"` plan from the
report's AI channel, an idea of its own, or **no trade** — with a stance recorded for every plan in the
report. It emits that choice as a `DailyDecisionInput` JSON block and runs `npm run decide -- --date <date>`,
the **only** writer: the CLI validates the choice against the report (fail closed, §5.15), sizes it with the
same `planTrade` the other two channels use, and writes `data/decisions/<date>.json` (committed, write-once)
plus a **Plan Report** `reports/<date>.decision.md` that states, in one page, which orders the owner places,
inside which window, and exactly when to come back — both for a position that has closed and for one still
open (§5.6, owner requirement 4). The persona channel is gated like the AI channel: forward-only, Gate D1
only, paper and leverage 1 until it passes (§8.5).

Operating context:

- Venue: Bybit V5, linear perpetuals (existing client `src/bybit/rest.ts`, SDK `bybit-official-ts-sdk`).
- Capital: `maxCapitalUsd` from `config.json` (currently $100 per `specs/profit-target-roadmap.md:65`).
- Candidates (revision 3): `config.symbols = ["BTC/USDT", "ETH/USDT"]` — the only symbols any channel, the
  persona included, may propose (§13 A27).
- Decision cadence: once per UTC day. Holding period: 1–10 days per rule.
- Execution: 100% manual. The system never holds a key with trade permission (§3 P4).
- Final reviewer of every rule, gate artifact, AI output, and trade: the owner.
- AI cost: bounded by `ai.monthlyBudgetUsd` (default $15). Note this is 15% of current capital per month — see §13 A15.

---

## 2. Evidence

### 2.1 Repository facts that drive the design

| # | Fact | Evidence |
|---|------|----------|
| E1 | Current strategy has negative out-of-sample edge: median −0.1767%/day, 15/47 folds positive, p = 0.9960, all 5 symbols lose. | `specs/profit-target-roadmap.md:3-7`; artifact `data/validation/walk-forward-2026-09-08.json` |
| E2 | Latest measurement: nothing on free 5m data reaches the AUC needed to break even. | commits `dc6aa0c`, `e37feee`; `data/validation/auc-feasibility-2026-09-08.json` |
| E3 | Leverage is pinned to 1x at the exchange; there is no leverage config field. | `src/bybit/connector.ts:403` (`setLeverage("linear", bybitSymbol, "1")`), `:425` (`pos.leverage !== "1"` blocks entries) |
| E4 | All backtest infrastructure is 5-minute. | `src/strategy/candles.ts:15` (`DEFAULT_INTERVAL_MS = 5 * 60_000`) |
| E5 | Before this spec, no non-price data fetchers existed (funding history, OI, macro, flows, on-chain, unlocks). | `rg -n "fundingRate/history\|open-interest\|defillama\|farside\|fred" src scripts` → no hits at commit `e37feee` (2026-09-16, before Phase 1). Phases 1–2 have since added them under `src/research/`. |
| E6 | The journal schema is scalping-specific. | `src/learning/journal.ts:39-43` (`indicatorsAtEntry: { rsi; momentum; atr }`) |
| E7 | The journal already has atomic write + 5 rotated backups — a reusable durability pattern. | `src/learning/journal.ts:54`, `:105-133` |
| E8 | Circuit breakers are pure functions over equity/pnl inputs — reusable without the auto-trader. | pure exported functions `src/risk/circuit-breaker.ts:59` (`createCircuitBreakerState`), `:76` (`checkEquityBreakers`), `:122` (`recordTradeOutcome`), `:127` (`checkConsecutiveLosses`), `:148` (`checkSlippage`); config type `:17-34` |
| E9 | Walk-forward stats helpers exist and are exported. | `src/strategy/walkforward.ts:101` (`median`), `:109` (`percentile`), `:120` (`binomialUpperTail`) |
| E10 | Funding P&L since a timestamp is already fetchable. | `src/bybit/connector.ts:895` (`getFundingPnlSince(sinceMs)`) |
| E11 | Test glob is non-recursive: only `tests/*.test.ts` runs. New tests in subdirectories would silently not run. | `package.json:8` |
| E12 (rev 3) | `planTrade` is pure and takes every sizing input explicitly — config bag, open-trade count, breaker flag, live-trade count, ladder flag, instrument filter and decision time — so a third channel can size through it **without modifying it**. | `src/research/planner.ts:127-139` (signature), `:148-229` (no I/O, no clock read) |
| E13 (rev 3) | The "non-rule channel = one synthetic `forwardOnly` rule whose id is a hash of the channel's instructions" pattern already exists and works: `aiIdeaToRule` builds it and `runAiAnalyst` feeds it to the same `planTrade`. Revision 3 copies that shape for the persona instead of inventing a second one. | `src/research/ai/analyst.ts:81-100` (`aiIdeaToRule`), `:268-278` (synthesized outcome → `planTrade`) |
| E14 (rev 3) | `promptVersionHash` deliberately hashes only behaviour-changing inputs and excludes budget, pricing, `cliPath`, timeout and channel status. `skillHash` (§5.15) follows the same line, so a config tweak never resets a track record and a prompt edit always does. | `src/research/ai/analyst.ts:62-74` |
| E15 (rev 3) | The shipped persona skill forbids producing plans in two places, so revision 3's decision gates are a **deliberate amendment** to a stated rule, not an oversight: "Discuss only (a) rule outputs present in the report … or (b) proposed rule definitions" and "Never state buy, sell, size, leverage, or venue for anything not in the report's `plans`". | `.claude/skills/crypto-fundamental-analyst/SKILL.md:18`, `:22` |
| E16 (rev 3) | The three example rules all list `["APT/USDT", "SOL/USDT"]`. Narrowing `config.symbols` to BTC + ETH **without editing them** makes `parseRuleSet`'s "symbols ⊆ config.symbols" check fail, so `research:daily` would exit 2 every day. The rules file must change in the same commit as the config. | `research-rules.json:10`, `:30`, `:53`; the check is `src/research/rules.ts:144` (`if (!configSymbols.includes(s))` → issue), reached from `parseRuleSet` (`:184`, `:200`) |

### 2.2 External evidence on data availability and on edge (researched 2026-09-16)

| # | Claim | Strength | Source |
|---|-------|----------|--------|
| X1 | Spot BTC ETF net flows correlate with same-day BTC returns (~53 bps per $100M, ~21% of daily variance); relation is bidirectional, so *forward* predictiveness is unproven. | Moderate (SSRN, 313 days) | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6592830 |
| X2 | BTC volatility around FOMC/CPI releases is elevated and rising since 2020 — supports volatility/risk rules, not direction. ~20 events/year limits inference. | Moderate (academic) | https://www.sciencedirect.com/science/article/pii/S1059056025006720 |
| X3 | Token unlocks are preceded by price declines, front-loaded 14–30 days before the date; likely partly arbitraged. | Weak (industry research, not peer-reviewed) | https://beincrypto.com/keyrock-research-token-unlocks/ |
| X4 | Funding-rate extremes as contrarian signal: mixed, no rigorous out-of-sample confirmation found. | Weak/mixed | https://tradingstrategies.work/blog/funding-rate-signal-btc-backtest |
| X5 | Unlock schedules are revised after the fact and vendors disagree; no free point-in-time history. | Verified example | https://tokenomist.ai/research/hype-tokenomics-330k-or-9-9m-hype-unlocks |
| X6 | Bybit/Binance native OI history is short (Binance: last 1 month); Coinalyze free API (40 req/min) offers longer aggregated history. | Docs | https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest-Statistics, https://api.coinalyze.net/v1/doc/ |
| X7 | Bybit funding-rate history is public and pageable (200 rows/page). | Docs | https://bybit-exchange.github.io/docs/v5/market/history-fund-rate |
| X8 | FRED `release/dates` gives historical release dates (CPI, NFP); ALFRED vintages give first-print values. Key required, 120 req/min. | Docs | https://fred.stlouisfed.org/docs/api/fred/ |
| X9 | DefiLlama free API (stablecoins, TVL, fees) needs no key. The unlocks/emissions API is Pro-only ($300/mo). | Docs | https://docs.llama.fi/pro-api |
| X10 | Farside publishes daily per-fund ETF flows as HTML tables; no official API. | Site | https://farside.co.uk/bitcoin-etf-flow-all-data/ |
| X11 | alternative.me Fear & Greed has free daily history since Feb 2018. | Docs | https://alternative.me/crypto/fear-and-greed-index/ |
| X12 | CryptoPanic's free API tier was discontinued in 2026. | Docs | https://cryptopanic.com/developers/api/about |
| X13 | `claude-opus-5` has a training-data cutoff of May 2026, which lies inside the D0 holdout window (2025-09-16 → 2026-09-15). Any backtest of the AI on that window is contaminated by look-ahead. | Fact (model environment) | Claude Code system context, 2026-09-16 |
| X14 | Structured outputs (`output_config.format`) guarantee schema-valid JSON on `claude-opus-5`, but numeric/string-length constraints are not enforced server-side (SDK validates client-side); refusal or `max_tokens` stops can yield non-matching output. Pricing $5/$25 per MTok in/out. | Docs (Anthropic SDK skill, cached 2026-06-24) | claude-api skill `shared/tool-use-concepts.md` §Structured Outputs |

**What this means for the design:** "fundamental analysis" at a 1–10 day horizon has, at best,
moderate evidence for a few catalysts and weak evidence for the rest. Nothing in §2.2 is an edge until
Gate D0 measures it on *this* system with *these* costs. Leverage multiplies a measured expectancy; it
cannot create one (E1).

---

## 3. Design principles

- **P1 — Fail closed, never substitute.** Any missing, stale, unparseable, or ambiguous input makes the
  dependent output `not_evaluable` and is shown loudly. The system never reuses yesterday's value as
  today's, never fills gaps, never guesses a fill. (Lesson L-008.)
- **P2 — Point-in-time or it didn't happen.** A feature may be used at decision time `T` only if the
  data behind it had `availableAt <= T`. Snapshots are write-once. Backtests use declared,
  conservative availability lags for history that was not snapshotted live.
- **P3 — Accountable channels, no unaccountable opinions.** Every plan comes from exactly one channel,
  recorded in `TradePlan.origin`: a versioned declarative rule in `research-rules.json` (`"rules-file"`), a
  verified AI analyst idea (`"ai-analyst"`, §5.13), or — revision 3 — a validated persona decision
  (`"persona"`, §5.15). AI ideas and persona decisions pass through the same planner, sizing, leverage and
  gates as rules; neither ever sets size, leverage or venue. Every AI **and persona** claim must cite evidence
  the system can verify (a snapshot feature value, or — for the AI channel only — a URL returned by the API's
  own search results); unverifiable claims are dropped, not shown as fact. The persona's own web searches are
  *not* captured by the system, so its web references are recorded as `unverified` and can never be an idea's
  only evidence (§5.15). The daily report (§5.6) still carries only rule and AI plans; the persona's choice
  lives in its own artifacts. Every report, Plan Report and persona reply carries the line:
  `Generated analysis for the owner's review. Not investment advice.`
- **P8 — The AI is an unvalidated source until measured.** The AI channel's ideas are `forwardOnly`
  (§8.4): its model has seen historical prices up to its training cutoff, so no backtest of it is
  honest. Its assessments of rule plans never change those plans; they are recorded and attributed
  so their value is measured (`byAiStance`, §5.9).
- **P9 — The persona decides, the system sizes and measures.** (Revision 3.) The interactive persona (§4.7)
  chooses *which* plan is today's plan — a report rule plan, a report AI plan, an idea of its own, or no
  trade. It never chooses *how much*: whatever it picks, the executed plan is produced by the existing
  `planTrade` (§5.5) from the same `PlannerConfig`, breaker state, open-trade count, instrument filters and
  decision time as any other plan, is recorded with `origin: "persona"`, and is journaled, gated and measured
  like any other channel (§5.15, §8.5). The persona never sets size, leverage or venue, and never writes a
  file: the only writer is `npm run decide` (§5.15), which refuses anything it cannot verify against that
  day's report (P1, P3). A persona choice that picks another channel's plan records `basedOnPlanId`, so the
  source rule's "chosen" record stays visible (§5.9) — but it credits the persona channel's track record, not
  the source rule's.
- **P4 — Read-only by construction.** The system holds only a Bybit API key without trade or withdraw
  permission and verifies that at startup. Humans place orders.
- **P5 — Leverage is an output, never an input.** Size comes from `risk = riskPerTradePercent × maxCapitalUsd`
  and stop distance. Leverage is the minimum needed to fit the margin budget, capped by `maxLeverage`,
  and rejected if liquidation is not safely beyond the stop.
- **P6 — Measure against the plan.** Every real position is linked to a plan or flagged `unplanned`.
  Adherence is measured, not assumed.
- **P7 — Artifact-first.** Every gate decision is a committed JSON artifact plus the command that
  regenerates it (same convention as `data/validation/*.json`).

---

## 4. Architecture and decomposition

Ports & adapters inside a new bounded area. Pure domain modules have no I/O and are unit-tested with
fixtures. Adapters do I/O and are tested with recorded payloads.

```
                    ┌────────────────────── scripts/research-daily.ts ─────────────────────┐
 sources/* (I/O) ──►│ snapshot-store ──► features (pure) ──► rules (pure) ──► planner (pure) │──► report-writer
                    │                         │                                    ▲         │        ▲
                    │                         └──► ai-analyst (port: AiClientPort) ─► verify ─┘        │
                    │                              (assesses rule plans, proposes ideas) ─── assessments ┘
                    └──────────────────────────────────────────────────────────────────────┘
 scripts/backtest-daily.ts: history-store ──► features ──► rules ──► planner ──► daily-sim ──► gate-d0
 journal-server: exchange-sync (read-only I/O) ──► manual-journal ──► trade-analytics (pure) ──► SSE/HTML
```

Decision layer (revision 3) — the persona is an interactive step *between* the report and the owner's hands:

```
 reports/<date>.{json,md}  ──►  owner + persona skill (§4.7, §4.23)  ──►  DailyDecisionInput (JSON block in chat)
                                        │ report plans + AI plans + news + theory            │
                                        │ (the persona never writes a file)                  ▼
                                                            scripts/decide-daily.ts (§4.22) --mode plan|manage|review
                                                                      │
                                    decision/decide.ts (pure) ────────┤ validate (fail closed) ─► personaIdeaToRule ─► planTrade (§5.5, unchanged)
                                                                      │                                   │
                                    decision/plan-report.ts (pure) ◄──┘                                    ▼
                                             │                                      data/decisions/<date>.json   (committed, write-once)
                                             ▼                                      data/decisions/<date>.manage.<tradeId>.json / .review.<tradeId>.json
                                    reports/<date>.decision.md  ──►  owner places orders by hand  ──►  journal (§4.11)
```

| Module | Responsibility | Pure? |
|--------|----------------|-------|
| 4.1 `src/research/sources/*.ts` | One adapter per source (§5.2). Fetch, validate shape, return typed rows with `availableAt`. | No |
| 4.2 `src/research/snapshot-store.ts` | Write-once daily snapshot files `data/snapshots/YYYY-MM-DD/<sourceId>.json` with `fetchedAt` + SHA-256. | No |
| 4.3 `src/research/features.ts` | Snapshot set + decision time → `FeatureVector` per symbol; enforces P2. | Yes |
| 4.4 `src/research/rules.ts` | Parse/validate `research-rules.json`; evaluate conditions → `RuleOutcome`. | Yes |
| 4.5 `src/research/planner.ts` | Rule outcome + price + config → `TradePlan` (size, leverage, liq buffer) per P5. | Yes |
| 4.6 `src/research/report.ts` | Assemble `DailyReport`; render JSON + Markdown; apply circuit-breaker suppression. | Yes (render) |
| 4.7 `.claude/skills/crypto-fundamental-analyst/SKILL.md` | Interactive persona for *authoring and critiquing rules*, discussing a report, and — revision 3 — **deciding today's plan** (§4.23, §5.15). Its domain instructions are loaded from the same `prompts/ai-analyst.md` used by §4.15, so both speak with one voice. It still writes nothing and still never states size, leverage or venue: it emits a `DailyDecisionInput` block that `npm run decide` validates and sizes (P9). | n/a |
| 4.8 `src/backtest-daily/history-store.ts` | Backfilled history with declared availability lags (§10.3). | No |
| 4.9 `src/backtest-daily/daily-sim.ts` | Simulate plans on 1h klines: entry, stop/target hit order, time exit, taker fees, funding. | Yes |
| 4.10 `src/backtest-daily/gate-d0.ts` | Holdout verdict, bootstrap CI, permutation test, holdout budget ledger. | Yes |
| 4.11 `src/journal/manual-journal.ts` | `ManualTrade` store, atomic write + 5 backups (pattern from E7), file `manual-journal.json`. | No |
| 4.12 `src/journal/exchange-sync.ts` | Read-only key check; import executions, positions, closed P&L, funding. | No |
| 4.13 `src/journal/trade-analytics.ts` | R-multiple, MAE/MFE, slippage, adherence, per-rule stats, breaker state. | Yes |
| 4.14 `src/server/journal-server.ts` + `public/journal.html` | Hono + SSE, separate entrypoint from `src/main.ts`, port 3082. | No |
| 4.15 `src/research/ai/analyst.ts` | Build `AiAnalystInput` from the day's snapshot, rule outcomes, rule plans and open trades; call the port; return `AiAnalystSection`. | Yes (given port) |
| 4.16 `src/research/ai/verify.ts` | Check every AI evidence ref against features and returned search results; drop unverifiable items; cap idea count. | Yes |
| 4.17 `src/research/ai/anthropic-client.ts` | The only module importing `@anthropic-ai/sdk`: implements `AiClientPort`; persists raw response to the day's snapshot dir. | No |
| 4.18 `src/research/ai/budget.ts` | Usage/cost ledger `data/ai-usage.jsonl`; month-to-date spend check before any call. | No |
| 4.19 `prompts/ai-analyst.md` | Versioned system prompt (role, evidence strength table §2.2, output rules). Part of `promptVersionHash` **and of `skillHash` (§5.15)**. | n/a |
| 4.20 `src/decision/decide.ts` (revision 3) | Validate a `DailyDecisionInput` against that date's report (fail closed), synthesize the persona rule, call `planTrade`, assemble `DailyDecision` and `OwnerProtocol`. | Yes |
| 4.21 `src/decision/plan-report.ts` (revision 3) | Render the owner-facing Plan Report Markdown (orders, execute window, gap rule, come-back timeline) from a `DailyDecision` + the `DailyReport`. | Yes |
| 4.22 `scripts/decide-daily.ts` (revision 3) | The **only** writer of `data/decisions/` and `reports/*.decision.md`: reads stdin/`--input`, loads report + journal + config, calls §4.20/§4.21, enforces write-once/`--revise`, sets exit codes. | No |
| 4.23 `.claude/skills/crypto-fundamental-analyst/` (revision 3) | Three new decision gates — `decide today's plan`, `manage open position`, `review closed trade` — plus `references/decision-protocol.md`. Produces the JSON block and may invoke §4.22; still writes nothing itself. | n/a |

The existing auto-trader (`src/main.ts`) is **not modified or deleted** by this spec (§11).

---

## 5. Public interface (contract)

All timestamps are UTC epoch milliseconds (`number`). All money is USD `number`. Symbols use the
existing `"BTC/USDT"` config format.

### 5.1 Shared types — `src/research/types.ts`

```ts
export type SourceId =
  | "bybit-klines-1d" | "bybit-klines-1h" | "bybit-funding" | "bybit-oi" | "bybit-instruments"
  | "coinalyze-oi" | "farside-btc-etf" | "farside-eth-etf" | "fred-release-dates"
  | "macro-calendar-manual" | "defillama-stablecoins" | "fear-greed" | "unlocks-manual";

export type SourceStatus = "ok" | "stale" | "unavailable" | "invalid";

export interface SourceRow {
  key: string;            // e.g. "BTC/USDT" or "USDT" or "CPI"
  observedFor: number;    // the period the value describes (start of UTC day, or event time)
  availableAt: number;    // earliest time this value could have been known
  value: number | string;
  field: string;          // e.g. "fundingRate", "netFlowUsd", "eventType"
}

export interface SourceSnapshot {
  sourceId: SourceId;
  fetchedAt: number;
  status: SourceStatus;
  statusDetail: string;   // non-empty whenever status !== "ok"
  rows: SourceRow[];
  sha256: string;         // of JSON.stringify(rows)
}

export interface SourceAdapter {
  id: SourceId;
  maxStalenessMs: number;
  /** Rejects never: network/parse failures are returned as status "unavailable"/"invalid". */
  fetch(decisionTime: number, symbols: readonly string[]): Promise<SourceSnapshot>;
}

export type FeatureName =
  | "close" | "return1d" | "return7d" | "atr14d" | "realizedVol7d"
  | "fundingRate8hAvg3d" | "fundingRatePercentile90d" | "oiChange3dPct"
  | "btcEtfNetFlowUsd1d" | "btcEtfNetFlowUsd5d" | "ethEtfNetFlowUsd1d"
  | "stablecoinSupplyChange7dPct" | "fearGreed"
  | "hoursToNextFomc" | "hoursToNextCpi" | "daysToNextUnlock" | "nextUnlockPctOfFloat";

export type FeatureValue =
  | { kind: "value"; value: number; availableAt: number; sourceId: SourceId }
  | { kind: "missing"; reason: string; sourceId: SourceId };

export type FeatureVector = { symbol: string; decisionTime: number; features: Record<FeatureName, FeatureValue> };

/** OHLCV bar; t = bar open time. New type (the 5m engine has no shared exported kline type). */
export interface Kline { t: number; o: number; h: number; l: number; c: number; v: number; }
```

### 5.2 Snapshot store — `src/research/snapshot-store.ts`

```ts
export class SnapshotExistsError extends Error { readonly path: string; }

/** Write-once. Throws SnapshotExistsError if the file exists (unless revision > 0 writes <sourceId>.r<revision>.json). */
export function writeSnapshot(dateUtc: string, snap: SourceSnapshot, opts?: { revision?: number; rootDir?: string }): string;

/** Returns latest revision per source for the date; empty array if the directory does not exist. Throws on SHA mismatch. */
export function readSnapshots(dateUtc: string, opts?: { rootDir?: string }): SourceSnapshot[];
```

### 5.3 Features — `src/research/features.ts`

```ts
/** Pure. Any row with availableAt > decisionTime is ignored (P2). A source with status !== "ok"
 *  or fetchedAt older than maxStalenessMs yields { kind: "missing" } for every feature it feeds. */
export function buildFeatures(
  snapshots: readonly SourceSnapshot[],
  symbols: readonly string[],
  decisionTime: number,
  staleness: Readonly<Record<SourceId, number>>,
): FeatureVector[];
```

### 5.3a Feature definitions (normative)

`T` = decision time. A daily bar is *completed* when `t + 86_400_000 <= T`. Percent values are ×100 (1.5 means 1.5%).
Market-wide features (ETF, stablecoin, fear & greed, macro) carry the same value in every symbol's vector.
A feature is `missing` when its minimum input count is not met.

| Feature | Definition | Min inputs | Source |
|---------|-----------|-----------|--------|
| `close` | close of the latest completed 1d bar | 1 bar | bybit-klines-1d |
| `return1d` | `(close_0 / close_1 − 1) × 100` over the 2 latest completed bars | 2 bars | bybit-klines-1d |
| `return7d` | `(close_0 / close_7 − 1) × 100` | 8 bars | bybit-klines-1d |
| `atr14d` | simple mean of true range over the 14 latest completed bars; `TR = max(h−l, |h−c_prev|, |l−c_prev|)` | 15 bars | bybit-klines-1d |
| `realizedVol7d` | sample stdev of the 7 latest daily log returns × √365 × 100 | 8 bars | bybit-klines-1d |
| `fundingRate8hAvg3d` | mean of funding rates with settlement time in `(T − 72h, T]` | 3 rows | bybit-funding |
| `fundingRatePercentile90d` | `100 × (count of rates in (T−90d, T] that are <= latest rate) / count` | 90 rows | bybit-funding |
| `oiChange3dPct` | `(oi_latest / oi_at_or_before(latest − 3d) − 1) × 100` using 1d OI rows | 4 rows | bybit-oi |
| `btcEtfNetFlowUsd1d` | total net flow (USD) of the latest US trading day available | 1 row | farside-btc-etf |
| `btcEtfNetFlowUsd5d` | sum of the 5 latest available US trading days | 5 rows | farside-btc-etf |
| `ethEtfNetFlowUsd1d` | as `btcEtfNetFlowUsd1d` | 1 row | farside-eth-etf |
| `stablecoinSupplyChange7dPct` | `(total_latest / total_at_or_before(latest − 7d) − 1) × 100` | 2 rows ≥7d apart | defillama-stablecoins |
| `fearGreed` | latest index value (0–100) | 1 row | fear-greed |
| `hoursToNextFomc` | `(first FOMC event time > T − T) / 3_600_000` | calendar covers `T + 45d` | macro-calendar-manual |
| `hoursToNextCpi` | hours to the first CPI release (08:30 America/New_York, DST-aware) after `T` | 1 future date | fred-release-dates |
| `daysToNextUnlock` | days to the first unlock of the symbol's base asset after `T` within 90 days; **999** if none (known absence, not missing) | file `asOf` ≤ 7d old | unlocks-manual |
| `nextUnlockPctOfFloat` | `pctOfCirculating` of that unlock; **0** if none within 90 days | as above | unlocks-manual |

**Contiguity (fail closed; added in Phase 4 after the critique found backfilled gaps would pass silently).** Minimum input
counts are not enough when history can have holes:
- `return1d`, `return7d`, `atr14d`, `realizedVol7d`: the N required daily bars must be consecutive (each `t` = previous `t` + 24 h); otherwise `missing` with reason `gap in daily bars`.
- `oiChange3dPct` and `stablecoinSupplyChange7dPct`: the "at or before" comparison row must be no more than 24 h older than its target time; otherwise `missing` (`gap`).
- `fundingRatePercentile90d`: the oldest row in the window must be within 24 h of the window start; otherwise `missing` (`gap`).
- `btcEtfNetFlowUsd5d`: the 5 rows must span at most 9 calendar days (weekends and US holidays allowed); otherwise `missing` (`gap`).
This applies to live runs too: `src/research/features.ts` is changed in Phase 4.

`availableAt` per adapter: exchange data = bar close / settlement time / OI timestamp; farside, defillama, fear-greed,
unlocks-manual = snapshot `fetchedAt` (conservative); macro-calendar-manual = `Date.parse(asOf)`; fred-release-dates = `fetchedAt`.

### 5.3b Manual input files, staleness, endpoints

```ts
// data/manual/macro-calendar.json  (committed; owner-maintained)
export interface MacroCalendarFile { asOf: string /* YYYY-MM-DD */; events: { type: "FOMC"; time: string /* ISO-8601 UTC */ }[]; }
// data/manual/unlocks.json  (committed; owner-maintained)
export interface UnlocksFile { asOf: string; unlocks: { asset: string /* e.g. "APT" */; time: string; pctOfCirculating: number }[]; }
```
Invalid JSON or shape → snapshot `invalid`; missing file → `unavailable`.

| SourceId | `maxStalenessMs` | Endpoint (public unless noted) |
|----------|------------------|--------------------------------|
| bybit-klines-1d | 26 h | `GET https://api.bybit.com/v5/market/kline?category=linear&symbol=<BYBIT>&interval=D&limit=100` |
| bybit-klines-1h | 2 h | same with `interval=60&limit=200` |
| bybit-funding | 9 h | `GET /v5/market/funding/history?category=linear&symbol=<BYBIT>&limit=200` (page back with `endTime` to cover 90 days) |
| bybit-oi | 26 h | `GET /v5/market/open-interest?category=linear&symbol=<BYBIT>&intervalTime=1d&limit=10` |
| bybit-instruments (Phase 2) | 7 d | `GET /v5/market/instruments-info?category=linear&symbol=<BYBIT>` → rows `minOrderQty`, `qtyStep`, `minNotionalValue` from `lotSizeFilter`; `availableAt = fetchedAt`; not a feature, read only by `instrumentFilters` |
| farside-btc-etf / farside-eth-etf | 4 d | HTML `https://farside.co.uk/bitcoin-etf-flow-all-data/`, `https://farside.co.uk/ethereum-etf-flow-all-data/`; fallback CSV §10.2 |
| fred-release-dates | 7 d | `GET https://api.stlouisfed.org/fred/release/dates?release_id=<CPI>&include_release_dates_with_no_data=true&sort_order=desc&file_type=json&api_key=$FRED_API_KEY`; CPI release id is a named constant verified against FRED at implementation |
| macro-calendar-manual | 120 d (by `asOf`) | file |
| defillama-stablecoins | 48 h | `GET https://stablecoins.llama.fi/stablecoincharts/all` |
| fear-greed | 26 h | `GET https://api.alternative.me/fng/?limit=10&format=json` |
| unlocks-manual | 7 d (by `asOf`) | file |
| coinalyze-oi (Phase 7, §5.16) | 26 h | `GET https://api.coinalyze.net/v1/open-interest-history?symbols=<BASE>USDT.6[,...]&interval=daily&from=<unix s>&to=<unix s>&api_key=$COINALYZE_API_KEY` (`.6` is Coinalyze's exchange code for Bybit) |

Symbol mapping uses the existing `appSymbolToBybit` (`src/bybit/adapters.ts:117`). Request timeout 10 s.

### 5.4 Rules — `src/research/rules.ts`

```ts
export type Comparator = "<" | "<=" | ">" | ">=" | "between";

export interface Condition { feature: FeatureName; op: Comparator; value: number | [number, number]; }

export interface RuleDefinition {
  id: string;                         // /^[a-z0-9-]{3,48}$/
  version: number;                    // integer >= 1, bumped on any change
  description: string;
  evidence: string[];                 // IDs from §2.2, e.g. ["X1"]; may be empty only if status is "experimental" or origin is "ai-analyst"/"persona" (their evidence lives in AiIdea.refs / PersonaIdea.refs)
  status: "experimental" | "holdout-passed" | "paper-passed" | "retired";
  symbols: string[];                  // subset of config.symbols
  side: "long" | "short";
  entryWhenAll: Condition[];          // length >= 1 for origin "rules-file"; empty for origin "ai-analyst" and "persona"
  invalidateWhenAny: Condition[];     // thesis invalidation, re-checked while a trade is open
  stopAtrMultiple: number;            // (0, 10]
  targetRMultiple: number;            // (0, 20]
  maxHoldDays: number;                // integer 1..10
  forwardOnly: boolean;               // true if any feature lacks point-in-time history (§10.3)
  origin: "rules-file" | "ai-analyst" | "persona";
  // parseRuleSet requires "rules-file"; "ai-analyst" rules are built only by aiIdeaToRule (§5.13);
  // "persona" rules only by personaIdeaToRule / the report-plan copy in decide.ts (§5.15, revision 3)
}

export interface RuleSet { schemaVersion: 1; rules: RuleDefinition[]; }

export class RuleSetValidationError extends Error { readonly issues: { path: string; message: string }[]; }

/** Throws RuleSetValidationError listing every issue (not just the first). */
export function parseRuleSet(json: unknown, configSymbols: readonly string[]): RuleSet;

/** SHA-256 of the canonical JSON of one rule; recorded in reports, plans, journal and gate artifacts. */
export function ruleHash(rule: RuleDefinition): string;

export type RuleOutcome =
  | { ruleId: string; ruleHash: string; symbol: string; result: "triggered"; evidence: Record<string, number> }
  | { ruleId: string; ruleHash: string; symbol: string; result: "not_triggered"; failed: FeatureName[] }
  | { ruleId: string; ruleHash: string; symbol: string; result: "not_evaluable"; missing: FeatureName[] };

/** Pure. not_evaluable if ANY referenced feature is missing — even if another condition already fails. */
export function evaluateRule(rule: RuleDefinition, fv: FeatureVector): RuleOutcome;

export type ThesisState = "intact" | "invalidated" | "not_evaluable";
export function evaluateThesis(rule: RuleDefinition, fv: FeatureVector): { state: ThesisState; conditions: FeatureName[] };
```

### 5.5 Planner — `src/research/planner.ts`

```ts
export interface PlannerConfig {
  maxCapitalUsd: number;
  riskPerTradePercent: number;     // existing config field, src/config.ts:42
  maxLeverage: number;             // new; integer 1..5; global ceiling (§5.11)
  liveLadderCap: number;           // new; integer 1..maxLeverage, default 2; applies to a rule's first 20 live trades (§8.3)
  marginBudgetPercent: number;     // new; % of maxCapitalUsd usable as margin for one trade, (0, 100]
  maintenanceMarginRate: number;   // new; default 0.005, used only for the planning estimate
  minLiqToStopRatio: number;       // new; default 2.0
  roundTripFeePercent: number;     // new; default 0.11 (taker 0.055% × 2)
  maxOpenManualTrades: number;     // from ManualTradingConfig; compared against openTradeCount
}

export type PlanOrigin = "rules-file" | "ai-analyst" | "persona";   // "persona" added in revision 3 (§5.15)

export type TradePlan =
  | {
      kind: "plan"; planId: string; ruleId: string; ruleHash: string; origin: PlanOrigin;
      symbol: string; side: "long" | "short";
      referencePrice: number; stopPrice: number; targetPrice: number; expiresAt: number;
      quantity: number; notionalUsd: number; riskUsd: number; leverage: number; marginUsd: number;
      estLiquidationPrice: number; liqToStopRatio: number; estRoundTripFeeUsd: number;
      venueIntent: "paper" | "live";  // "live" only if rule.status === "paper-passed" (§8)
      maxHoldDays: number;            // copied from the rule; used by exit classification (§5.8a)
      /** Revision 3, persona provenance. Both OPTIONAL so `planTrade` is not modified: it never sets
       *  them, and `src/decision/decide.ts` attaches them afterwards (§5.15 `withPersonaProvenance`).
       *  Set only on a `origin: "persona"` plan whose choice was `kind: "report-plan"`. */
      basedOnPlanId?: string | null;   // the report planId the persona chose
      basedOnRuleKey?: string | null;  // "<that plan's ruleId>@<first 8 chars of its ruleHash>" (§5.9 key format)
    }
  | { kind: "rejected"; ruleId: string; origin: PlanOrigin; symbol: string; reason: "liq_too_close" | "size_below_min" | "atr_missing" | "breaker_tripped" | "max_open_trades" | "instrument_missing" };

/** Pure. Returns 1 unless rule.status === "paper-passed";
 *  then liveLadderCap if liveClosedTradesForRule < 20 or ladderResetByBreaker, else maxLeverage. */
export function effectiveMaxLeverage(rule: RuleDefinition, cfg: PlannerConfig,
  liveClosedTradesForRule: number, ladderResetByBreaker: boolean): number;

/** Exchange order-size filters for one symbol (Bybit lotSizeFilter). */
export interface InstrumentFilter { minOrderQty: number; qtyStep: number; minNotionalValue: number; }

/** Pure. Reads the "bybit-instruments" snapshot (§5.3b); a symbol absent or with non-positive values maps to null. */
export function instrumentFilters(snapshots: readonly SourceSnapshot[], symbols: readonly string[]): Record<string, InstrumentFilter | null>;

/** Pure. planId = `${dateUtc}:${ruleId}:${symbol}`. Uses effectiveMaxLeverage(...) as the leverage cap.
 *  decisionTime is the effective decision time (§5.12). instrument null → rejected "instrument_missing". */
export function planTrade(outcome: Extract<RuleOutcome, { result: "triggered" }>, rule: RuleDefinition,
  fv: FeatureVector, cfg: PlannerConfig, openTradeCount: number, breakerTripped: boolean, dateUtc: string,
  liveClosedTradesForRule: number, ladderResetByBreaker: boolean,
  instrument: InstrumentFilter | null, decisionTime: number): TradePlan;

/** Linear isolated estimate: long entry×(1 − 1/L + mmr), short entry×(1 + 1/L − mmr). */
export function estimateLiquidationPrice(entry: number, side: "long" | "short", leverage: number, mmr: number): number;
```

Open-trade accounting (normative): `openTradeCount` is a running counter for the whole `research:daily` run. It starts
at the number of `status: "open"` journal trades for venue `bybit-live` plus venue `paper`, is incremented by 1 after
every `kind: "plan"` result (rule plans in `research-rules.json` order, then AI plans in idea order), and is not
incremented by `rejected` results. So with `maxOpenManualTrades = 3`, 1 open trade and 4 triggered rules, exactly 2
plans and 2 `rejected: max_open_trades` are produced.

Sizing algorithm (normative): `riskUsd = maxCapitalUsd × riskPerTradePercent/100`;
`stopDistance = atr14d × stopAtrMultiple`; `quantity = riskUsd / stopDistance`;
`notionalUsd = quantity × referencePrice`; `marginBudget = maxCapitalUsd × marginBudgetPercent/100`;
`leverage = max(1, ceil(notionalUsd / marginBudget))`. If `leverage > effectiveMaxLeverage`, set
`leverage = effectiveMaxLeverage` and scale `quantity` down so `notionalUsd / leverage = marginBudget`
(riskUsd shrinks accordingly). Then `liqToStopRatio = |referencePrice − estLiquidationPrice| / stopDistance`;
if `< minLiqToStopRatio`, decrement leverage and re-scale quantity until it passes or leverage = 1; if
still failing → `rejected: liq_too_close`. Finally `quantity` is rounded **down** to a multiple of `qtyStep`
(floating-point safe: `floor(quantity / qtyStep + 1e-9) × qtyStep`); if the result is `< minOrderQty` or its notional
`< minNotionalValue` → `rejected: size_below_min`. After rounding, `notionalUsd`, `riskUsd` (= quantity × stopDistance),
`marginUsd` (= notionalUsd / leverage) and `estRoundTripFeeUsd` (= notionalUsd × roundTripFeePercent / 100) are
recomputed from the rounded quantity. Rounding never increases risk.

Check order (first match decides): `breaker_tripped` → `max_open_trades` → `instrument_missing` → `atr_missing`
(also when `close` is missing) → sizing → `liq_too_close` → `size_below_min`.

Price levels (normative): `referencePrice = close` feature; long `stopPrice = referencePrice − stopDistance`,
`targetPrice = referencePrice + stopDistance × targetRMultiple`; short mirrored. `expiresAt = decisionTime + 12 h` (A2).
`venueIntent = rule.status === "paper-passed" ? "live" : "paper"`.

### 5.6 Report — `src/research/report.ts`

```ts
export interface DailyReport {
  schemaVersion: 1; dateUtc: string; decisionTime: number; generatedAt: number;
  ruleSetSha256: string;
  sources: { sourceId: SourceId; status: SourceStatus; statusDetail: string; fetchedAt: number; sha256: string }[];
  completeness: "complete" | "incomplete";   // "incomplete" iff any source status !== "ok"
  breaker: { tripped: boolean; trigger: string | null; details: string };
  outcomes: RuleOutcome[];
  plans: TradePlan[];
  openTradeThesis: { tradeId: string; ruleId: string; state: ThesisState; conditions: FeatureName[] }[];
  aiAnalyst: AiAnalystSection;                // §5.13; status "disabled" when ai.enabled is false
  disclaimer: "Generated analysis for the owner's review. Not investment advice.";
}

// buildReport evaluates the rule set itself (evaluateRule → planTrade with the running open-trade counter), so
// `outcomes` and rule `plans` are outputs, not inputs. Renderers split channels by `origin`, never by position.

/** Pure. Appends ai.plans to plans (after rule plans) and sets aiAnalyst. Never modifies an existing plan. */
export function attachAiAnalyst(report: DailyReport, ai: AiAnalystSection): DailyReport;

export function buildReport(input: {
  dateUtc: string; decisionTime: number; now: number; ruleSet: RuleSet; ruleSetSha256: string;
  snapshots: SourceSnapshot[]; features: FeatureVector[]; plannerConfig: PlannerConfig;
  breaker: { tripped: boolean; trigger: string | null; details: string };
  openTrades: ManualTrade[];
  aiDisabledReason: null | "config" | "cli-flag";  // null = AI enabled; "config" = ai.enabled false; "cli-flag" = --no-ai
}): DailyReport;  // aiAnalyst = { status: aiDisabledReason === null ? "pending" : "disabled",
                  //   reason: null → "", "config" → "ai.enabled is false", "cli-flag" → "--no-ai"; all other fields empty/null/0 }

/** Markdown: completeness banner first line; then "Rules channel" (each rule plan with evidence values,
 *  source statuses and the AI stance next to it); then "AI analyst channel — forward-only, unvalidated"
 *  (regime summary, AI plans, open-trade notes, risks, data gaps, rejected-item count, cost). */
export function renderReportMarkdown(r: DailyReport): string;
```

#### 5.6a Plan Report — `reports/<date>.decision.md` (revision 3, normative layout)

`DailyReport` is **unchanged** by revision 3: the daily report still carries only rule and AI plans, and
`renderReportMarkdown` is not modified. The persona's decision is rendered separately by
`renderPlanReport` (§4.21, §5.15) into `reports/<date>.decision.md` — the single page the owner acts on.
This is owner requirement 4 ("be very clear on the plan report and when I have to execute it and when I
have to come back"), so the layout below is normative: sections in this order, with these headings, and
section 2's table present in **every** Plan Report, including a `no-trade` one.

| # | Heading | Must contain |
|---|---------|--------------|
| — | `# Plan Report — <dateUtc>` | the decision line (symbol, side, channel, `persona-<hash8>`), `decidedAt` in UTC **and** UTC−3, the source report path + its `sha256`, its `decisionTime` and `completeness`, and `basedOnPlanId` when the choice was `report-plan` |
| 1 | `## 1. Execute now — the orders you place by hand` | venue (`paper` ⇒ "place nothing on Bybit, record it in the journal"), margin mode `isolated`, leverage, quantity, the 3-row order table (entry / reduce-only stop / reduce-only take-profit) with prices and quantity, `riskUsd`, `estRoundTripFeeUsd`, `estLiquidationPrice` + `liqToStopRatio`, the **execute window** (`decidedAt` → `expiresAt` in UTC and UTC−3), the **gap rule** band, and the exact recording step (paper: `POST /api/paper/entry` with this `planId`; live: link the synced position). A `no-trade` decision replaces the whole section with `**No trade today.** <reason>`; sections 2, 4 and 7 still follow, because "no new trade" does not mean "nothing to do" — positions opened on earlier days still have come-back dates and their own manage artifacts. |
| 2 | `## 2. When to come back` | the timeline table `\| When \| You do \| Then \|` with, at minimum, one row whose *When* cell names the **next daily report** (00:15 UTC / 21:15 UTC−3 the evening before), one whose *When* cell contains `Position closed`, one whose *When* cell contains `still open`, one naming the **hard time exit** date (`maxHoldDays`), and one intraday row whose *You do* cell contains the literals `journal dashboard` and `alerts only`. The `Position closed` row's *You do* cell names the paper-exit recording step (`POST /api/paper/exit` with `exitKind`) for a `paper` venue, because a paper position closes only when the owner records it. Every artifact path printed here is the **per-trade** one, `data/decisions/<date>.manage.<tradeId>.json` / `.review.<tradeId>.json` (§5.15) |
| 3 | `## 3. Why this plan` | the persona's `rationale` and, for a `persona-idea`, its thesis, catalysts and `invalidateWhenAny` conditions in plain words |
| 4 | `## 4. Stances on every plan in today's report` | one row per `kind:"plan"` plan in the report: `planId`, channel (`rules-file` / `ai-analyst`), stance, reasons — chosen plan marked `← chosen` |
| 5 | `## 5. News checked` | `\| title \| url \| date \| tag \|`, tags as the persona's news protocol (`confirmed` / `unconfirmed` / `contradicts`), or the literal `News: not checked` |
| 6 | `## 6. Not verified by the system` | every `unverified` web ref and every validator warning, with the sentence that web references are the persona's own searches and are **not** captured by the system |
| 7 | `## 7. Other open positions` | one row per **other** `status:"open"` journal trade (every open trade whose id is not this decision's own): `tradeId`, symbol, side, `planId`, and the per-trade manage artifact path for today. Omitted only when there is no other open trade; then the section reads `None.` |
| — | last line | the §5.6 disclaimer, verbatim |

**Scope of one Plan Report (per-trade, not per-day).** Sections 1–3 describe **this decision's own trade and
nothing else**: its orders, its execute window, its time exit, its come-back rows. The owner can hold up to
`maxOpenManualTrades` positions, and a position opened three days ago is governed by **its own** Plan Report and
by its own per-trade manage artifacts — never by today's. Section 7 exists so today's page still *names* those
other positions and where their instructions live, without pretending to restate them: one
`npm run decide -- --mode manage --trade <id>` call, and one artifact, per open trade (§5.15).

Literal example (numbers from AC-11's inputs; UTC−3 is the owner's local time, §13 A28):

```markdown
# Plan Report — 2026-09-18

**BTC/USDT LONG** · channel `persona` (`persona-3f9a1c2b`, experimental → paper) · decided 2026-09-18 00:41 UTC (2026-09-17 21:41 UTC−3)
Based on report plan `2026-09-18:etf-flow-momentum:BTC/USDT` · report `reports/2026-09-18.json` (sha256 `8c1d4f0a…`), decisionTime 2026-09-18 00:15 UTC, completeness `complete`

## 1. Execute now — the orders you place by hand

Venue **paper** — place nothing on Bybit; record it in the journal. Margin mode: **isolated**. Leverage: **1x**. Quantity: **0.0005 BTC** (notional $30.00, margin $30.00).

| # | Order | Type | Price | Quantity | Reduce-only |
|---|-------|------|-------|----------|-------------|
| 1 | Entry — BUY | market | ~60,000.00 (reference) | 0.0005 | no |
| 2 | Stop loss — SELL | stop-market | 58,000.00 | 0.0005 | **yes** |
| 3 | Take profit — SELL | limit | 64,000.00 | 0.0005 | **yes** |

Risk if stopped: **$1.00** (1.0% of $100). Est. round-trip fee: $0.033. Est. liquidation 30,300.00 — 14.85× the stop distance away (1x isolated: liquidation sits about half-way to zero).

**Execute window:** 2026-09-18 00:41 UTC → **2026-09-18 06:41 UTC** (2026-09-17 21:41 → 2026-09-18 03:41 UTC−3). After it closes, do not enter: wait for tomorrow's report.
**Gap rule:** do not enter if the mark is more than **500.00** away from 60,000.00 (0.25 × ATR14d 2,000.00) — i.e. outside **59,500.00 – 60,500.00**. If it is outside, do not enter.
**Record it:** paper → `npm run journal` → `POST /api/paper/entry {"planId":"2026-09-18:persona-3f9a1c2b:BTC/USDT","fillPrice":<your fill>,"time":<ms>}`.

## 2. When to come back

| When | You do | Then |
|------|--------|------|
| **Every day at 00:15 UTC (21:15 UTC−3 the evening before), after the timer has run** | Read `reports/<date>.md`, then open the persona | It runs `manage open position` or `review closed trade` **once per trade** and writes each call through `npm run decide` |
| **Position closed** — stop 58,000.00 hit, target 64,000.00 hit, or the time exit below | Paper: record the exit the same day with `POST /api/paper/exit {"tradeId":"<tradeId>","fillPrice":<price>,"time":<ms>,"exitKind":"stop"\|"target"\|"time"}` (the journal has no exchange to see it). Live: start `npm run journal` (it syncs on startup and every 30 s) and check `GET /api/state` shows `lastSync.status: "ok"`. Then, at the **next** daily report, ask the persona to `review closed trade` for this trade | `data/decisions/<date>.review.<tradeId>.json` — R, exit kind, adherence, thesis verdict, lesson |
| **Position still open** at the next daily report | Ask the persona to `manage open position` for this trade | `data/decisions/<date>.manage.<tradeId>.json` with exactly one of `hold` / `tighten stop to <price>` / `close now` — you execute it by hand that morning |
| **2026-09-23 (maxHoldDays 5) — hard time exit** | Close the position yourself that day at whatever price it is | Record the exit with `exitKind: "time"` (paper: `POST /api/paper/exit`; live: the sync picks it up, you set the exit kind in the dashboard) |
| **Intraday, any time** | Nothing. The **journal dashboard**'s **alerts only** — no persona session between daily reports | Nothing to run |

(`<tradeId>` is filled in once you record the entry; until then the journal has no id for this plan.)

## 3. Why this plan
…
## 4. Stances on every plan in today's report
| planId | channel | stance | reasons |
|--------|---------|--------|---------|
| `2026-09-18:etf-flow-momentum:BTC/USDT` ← chosen | rules-file | support | … |
| `2026-09-18:ai-analyst-7d2e:ETH/USDT` | ai-analyst | caution | … |
## 5. News checked
| title | url | date | tag |
## 6. Not verified by the system
- web ref `https://…` — persona search result, **unverified** (the system does not capture the persona's searches).
## 7. Other open positions

These are **not** governed by this page — each has its own Plan Report and its own per-trade artifact today:

| tradeId | symbol | side | planId | Today's manage artifact |
|---------|--------|------|--------|-------------------------|
| `7c1f…` | ETH/USDT | long | `2026-09-15:persona-3f9a1c2b:ETH/USDT` | `data/decisions/2026-09-18.manage.7c1f….json` |

Generated analysis for the owner's review. Not investment advice.
```

### 5.7 Manual journal — `src/journal/manual-journal.ts`

```ts
export type ManualTradeVenue = "paper" | "bybit-live";   // testnet deliberately excluded
export type ExitKind = "stop" | "target" | "time" | "thesis_invalidated" | "discretionary" | "liquidation" | "unknown";

export interface Fill { execId: string; time: number; price: number; qty: number; feeUsd: number; side: "buy" | "sell"; }

export interface ManualTrade {
  id: string;                       // uuid
  venue: ManualTradeVenue;
  symbol: string; side: "long" | "short";
  planId: string | null;            // null => unplanned
  ruleId: string | null; ruleHash: string | null;
  plannedSnapshot: Extract<TradePlan, { kind: "plan" }> | null;  // frozen copy at link time
  aiStanceAtPlan: AiStance | null;  // AI assessment of this plan in the same report; null if unplanned, AI unavailable, or plan is AI-origin
  entryFills: Fill[]; exitFills: Fill[];
  actualLeverage: number | null; exchangeLiqPrice: number | null;
  fundingUsd: number;               // signed; negative = paid
  status: "open" | "closed";
  exitKind: ExitKind | null;
  notes: string;                    // owner free text, pre- and post-trade
  createdAt: number; updatedAt: number;
}

// Revision 3: `ManualTrade` has no `origin` field of its own — a trade's channel is
// `plannedSnapshot.origin` (`"rules-file" | "ai-analyst" | "persona"`, §5.5 `PlanOrigin`), and its
// persona provenance is `plannedSnapshot.basedOnPlanId` / `basedOnRuleKey`. Widening `PlanOrigin` is
// therefore the only change needed here: a persona plan links, paper-records, syncs, classifies and
// reviews exactly like a rule or AI plan. `aiStanceAtPlan` stays null for persona-origin trades (the
// batch AI assesses only rule plans); the persona's own stance on the plan it chose lives in
// `data/decisions/<date>.json`.

export function loadManualJournal(opts?: { path?: string }): ManualTrade[];   // falls back through .bak.1..5; throws JournalUnreadableError if all fail
export function saveManualJournal(trades: readonly ManualTrade[], opts?: { path?: string }): void; // atomic + rotate 5 backups
export function linkTradeToPlan(trade: ManualTrade, plan: Extract<TradePlan, { kind: "plan" }>, aiStance: AiStance | null, now: number): ManualTrade;
export function recordPaperEntry(plan: Extract<TradePlan, { kind: "plan" }>, aiStance: AiStance | null, fillPrice: number, time: number): ManualTrade;
export function recordPaperExit(trade: ManualTrade, fillPrice: number, time: number, exitKind: ExitKind): ManualTrade;
export class JournalUnreadableError extends Error {}
```

### 5.8 Exchange sync — `src/journal/exchange-sync.ts`

```ts
export class TradePermissionKeyError extends Error {}   // key has Trade/Withdraw permissions

export interface SyncResult {
  syncedAt: number;
  status: "ok" | "failed";
  error: string | null;
  newFills: number;
  positions: { symbol: string; side: "long" | "short"; size: number; avgPrice: number; leverage: number; liqPrice: number; markPrice: number; unrealisedPnl: number }[];
  warnings: string[];   // e.g. "BTC/USDT: first execution after journalStartTime reduces a position opened earlier — not journaled"
}

/** Calls rest.getApiKeyInfo() (SDK user.getApiKey → GET /v5/user/query-api, new additive RestClient method); throws
 *  TradePermissionKeyError unless readOnly === 1 and no Withdraw permission. A network failure also throws (fail closed). */
export function assertReadOnlyKey(rest: RestClient): Promise<void>;

/** Pure. Rebuilds trades from raw executions per §5.8a. */
export function reconstructTrades(executions: readonly RawExecution[], existing: readonly ManualTrade[], symbols: readonly string[], now: number):
  { journal: ManualTrade[]; warnings: string[] };

export interface RawExecution { execId: string; symbol: string /* app format */; side: "buy" | "sell"; price: number; qty: number;
  feeUsd: number; time: number; execType: "Trade" | "BustTrade"; }

/** Fetches executions for cfg.symbols from max(journalStartTime, newest known fill time − 1 h) to now in ≤ 7-day windows with
 *  cursor paging (dedupe by execId), reconstructs trades, then sets fundingUsd per trade and reads positions.
 *  Any fetch error → status "failed", journal returned unchanged (never partially updated). Never rejects. */
export function syncFromExchange(journal: ManualTrade[], rest: RestClient, cfg: { symbols: string[]; journalStartTime: number | null },
  now: number): Promise<{ journal: ManualTrade[]; result: SyncResult }>;
```

### 5.8a Journal reconstruction, classification and breaker (normative, Phase 3)

**Evidence that shapes this section.** `BybitConnector.getFundingPnlSince` catches per-symbol errors and returns a partial total
(`src/bybit/connector.ts:905-907`), which violates P1, and its sign is marked unverified (`src/bybit/connector.ts:883-896`). It is
therefore **not used**. `RestClient` has no execution-list or API-key method (`src/bybit/rest.ts` exposes only
`getFundingHistory`, `:263`, filtered to `execType: "Funding"`); the SDK provides `trade.getTradeHistory` and `user.getApiKey`.

**RestClient additions (additive only):** `getApiKeyInfo(): Promise<{ readOnly: 0 | 1; permissions: Record<string, string[]> }>`
and `getExecutions(category: string, symbol: string, startTime: number, endTime: number, cursor?: string): Promise<{ list: unknown[]; nextPageCursor: string }>`
(no `execType` filter; the caller keeps `Trade` and `BustTrade`, ignores others).

**Sync start.** `manual.journalStartTime` (ISO-8601 UTC) is required for live sync. Absent → live sync disabled, `SyncResult`
`status: "failed"`, `error: "manual.journalStartTime not set"`. This keeps the old auto-trader's history out of the journal.

**Reconstruction.** Per symbol, executions sorted by `(time, execId)`; keep a signed running quantity (buy +, sell −).
- 0 → non-zero opens a trade (`venue: "bybit-live"`, `planId: null`); fills that grow |qty| are `entryFills`, fills that shrink it are `exitFills`.
- |qty| ≤ 1e-9 closes the trade (`status: "closed"`).
- A fill that crosses zero is split: the closing part is an exit fill (`execId`), the remainder opens a new trade (`execId + ":flip"`); fee is split pro rata by quantity.
- **Unseen positions** are detected from Bybit's `closedSize` ("Closed position size", documented on `/v5/execution/list`), never from the fill's side: when no journal trade is open for the symbol, an execution with `closedSize > 0` closed a position opened before `journalStartTime`. That part is not journaled (warning). If `qty − closedSize > 0`, the remainder opened a new position and is journaled as `execId + ":flip"` with fee pro rata. A side-based guess would misread a buy closing an old short as a new long.
- **execTypes:** `Trade` and `BustTrade` are replayed; `AdlTrade` is replayed as `Trade`; `Funding` is ignored (fetched separately). Any other execType, or an execution missing/invalid `execId`, `side`, `execPrice`, `execQty > 0`, `execFee`, `execTime` or `closedSize ≥ 0`, fails the whole sync (`status: "failed"`, journal unchanged) — never dropped, never treated as a trade.
- Existing trades are matched by fill `execId`; plan links, notes and owner-set `exitKind` survive re-sync.
- **Open trades are never orphaned.** The fetched symbol set is `cfg.symbols ∪ symbols of open bybit-live trades`, and each
  symbol with an open trade is fetched from `min(normal start, that trade's newest fill time − 1 h)`, regardless of later changes
  to `journalStartTime` or `config.symbols`. A symbol fetched only because of an open trade adds the warning
  `"<symbol>: open journal trade but symbol not in config.symbols"`.

**Funding.** `fundingUsd = −Σ execFee` of `getFundingHistory` rows for the trade's symbol with time in
`[first entry time, last exit time or now]`. Any error → sync `failed`. The sign is unverified: `manual.fundingSignVerified`
(default `false`) makes the dashboard label every funding value `sign unverified` until the owner confirms one real settlement (§12.13).

**Exit classification (bybit-live, on close).** First match: any exit fill `BustTrade` → `liquidation`; unplanned → `unknown`;
with `d = |referencePrice − stopPrice|` of `plannedSnapshot` and `avgExit` the quantity-weighted exit price:
long `avgExit ≤ stopPrice + 0.25·d` (short mirrored) → `stop`; long `avgExit ≥ targetPrice − 0.25·d` → `target`;
`lastExitTime ≥ firstEntryTime + maxHoldDays·24 h − 1 h` → `time`; else `discretionary`. The owner may change `discretionary`
to `thesis_invalidated` only (`PATCH /api/trades/:id/exit-kind`). Paper exits carry the owner-supplied `exitKind`.

**Linking.** `POST /api/trades/:id/link {planId}` loads the plan from the latest revision of `reports/<planId date>.json`. It
returns 409 unless symbol and side match, the trade's first entry time is in `[report decisionTime, plan expiresAt]`, and the plan
is `kind: "plan"`. `aiStanceAtPlan` comes from that report's `aiAnalyst.assessments`. Never automatic.
**(Revision 3)** A `planId` whose middle segment starts with `persona-` is **not** in any report: the server loads it from the
effective (highest-revision) `data/decisions/<planId date>.json` and matches `decision.plan.planId`, returning 404 when that file
or plan is absent. The window check then uses `[decision.decidedAt, decision.ownerProtocol.executeUntil]` instead of the report's
— a persona plan's entry window is its own execute window (§5.15), not the report's 12 h `expiresAt`. `aiStanceAtPlan` is null for
these. The same resolution applies to `POST /api/paper/entry {planId, …}`, and to `research:daily`'s `openTradeThesis` step, which
loads an open persona trade's rule from that file's `personaRule` (missing/unreadable file → `not_evaluable`, as for AI rules).

**Paper trades.** `recordPaperEntry`: quantity = plan quantity, one fill at `fillPrice`, `feeUsd = notional × roundTripFeePercent / 200`.
`recordPaperExit`: same fee rule, owner-supplied `exitKind`; funding 0.

**Analytics formulas.** Long `grossPnl = Σexit(q·p) − Σentry(q·p)`, short negated; `netPnlUsd = grossPnl − fees + fundingUsd`.
`entrySlippagePct`: long `(avgEntry / referencePrice − 1)·100`, short `(1 − avgEntry / referencePrice)·100` (positive = adverse).
`sizeDeviationPct = |entryQty / plan.quantity − 1|·100`. `maePct` / `mfePct`: worst / best excursion of 1h kline lows/highs
overlapping `[firstEntry, lastExit]` relative to `avgEntry`, in the trade's direction (MAE ≤ 0 ≤ MFE).
`followedPlan = planned ∧ exitKind ∈ {stop, target, time, thesis_invalidated} ∧ sizeDeviationPct ≤ 10 ∧ actualLeverage ≤ plan.leverage`
(paper trades: leverage check skipped). `winRate` = share with `netPnlUsd > 0`. `expectancyR` = mean `rMultiple` of planned trades.
`maxDrawdownR` = largest peak-to-trough of cumulative R in exit-time order. Live view (long; short mirrored):
`distanceToStopPct = (mark − stop) / mark·100`, `distanceToLiqPct = (mark − liq) / mark·100`, `liqBeyondStop = liq < stop`.
`thesis` comes from the latest report's `openTradeThesis` for the trade; absent → `not_evaluable`.
`hoursToExpiry` for an open trade = `(firstEntryTime + plan.maxHoldDays·24 h − now) / 1 h` (the plan's `expiresAt` is only the
12 h entry window and stops mattering once filled); alert `expired` when ≤ 0; `null` when unplanned. Alert
`stop_beyond_liquidation` fires when `liqBeyondStop === false` (liquidation would be reached before the stop).

**Breaker from the journal.** Pure `computeBreaker(trades, cbConfig, maxCapitalUsd, now)`: replay closed `bybit-live` trades in
exit-time order through `src/risk/circuit-breaker.ts` (`createCircuitBreakerState(maxCapitalUsd, firstExitTime)`, then per trade
`checkEquityBreakers` with equity = `maxCapitalUsd + cumulative netPnlUsd`, `recordTradeOutcome`), then a final
`checkEquityBreakers` and `checkConsecutiveLosses` at `now`. Each trade is replayed with **two** `checkEquityBreakers` calls at
**that trade's exit time**: first with the equity *before* the trade (this performs any UTC-day rollover, so the new day starts
from pre-trade equity), then with the equity *after* it. Calling only with post-trade equity would make the first loss of each
day invisible to `dailyLoss`, because rollover resets `dayStartEquity` to the equity passed in (`src/risk/circuit-breaker.ts:85-87`). Latching (matches the auto-trader, which latches any
trigger until a human clears it, `src/main.ts:219`, `:476`):
- `dailyLoss` holds for the rest of the UTC date on which it tripped, even if later trades recover equity.
- `drawdown` and `consecutiveLosses` hold **until the owner resets them**: `manual.breakerResetAt` (ISO-8601 UTC, default null).
  A reset after a trip clears it, and the replay re-baselines at that instant: `createCircuitBreakerState(equityAtReset, resetTime)`
  (peak = equity at reset, consecutive losses = 0), then continues with trades exiting after `resetTime`.
- **Tripped** iff the final check trips, or a `dailyLoss` trip exists on `now`'s UTC date, or a `drawdown`/`consecutiveLosses`
  trip exists after the last reset. The reported trigger is the earliest active trip. Config values come from the existing
`maxDailyLossPercent` / `maxDrawdownHaltPercent` / `maxConsecutiveLosses` (`src/config.ts:24-28`), defaults otherwise.
**Ladder reset** (§8.3): until the trip log exists (Phase 4), `ladderResetByBreaker` is always `true` — the leverage cap stays at
`liveLadderCap` (fail closed). No rule can reach `paper-passed` before Phase 4 anyway.

**research:daily wiring.** Reads `manual-journal.json`: `openTrades` = open trades of both venues, `openTradeCount` starts at their
count, `liveClosedTradesForRule` = closed `bybit-live` trades with that `ruleId`, breaker = `computeBreaker`. Missing file → empty
journal. Unreadable (all backups corrupt) → exit **5**, no report written.

**Server.** Binds `127.0.0.1:journalPort`. Live sync every `manual.syncIntervalMs` (default 30 000). No read-only key in
`BYBIT_READONLY_API_KEY`/`_SECRET` → server starts in paper-only mode with a banner (key with trade/withdraw permission still refuses
to start). Every request must carry `Host` = `127.0.0.1:<port>` or `localhost:<port>`, and every non-GET request with an `Origin`
header must have that same origin — otherwise 403 (blocks DNS-rebinding/CSRF from other browser pages).

### 5.9 Trade analytics — `src/journal/trade-analytics.ts`

```ts
export interface LiveTradeView {
  tradeId: string; markPrice: number | null; unrealisedPnlUsd: number | null;
  distanceToStopPct: number | null; distanceToLiqPct: number | null; liqBeyondStop: boolean | null;
  fundingUsd: number; heldHours: number; hoursToExpiry: number | null;
  thesis: ThesisState; stale: boolean; staleSinceMs: number | null;
  alerts: ("stop_beyond_liquidation" | "size_deviates_from_plan" | "leverage_exceeds_plan" | "thesis_invalidated" | "expired" | "unplanned" | "data_stale")[];
}

export interface ClosedTradeReview {
  tradeId: string; ruleId: string | null; ruleHash: string | null; origin: PlanOrigin | null; aiStanceAtPlan: AiStance | null;
  basedOnRuleKey: string | null;             // revision 3: plannedSnapshot.basedOnRuleKey, null unless origin "persona" on a chosen report plan
  plannedRiskUsd: number | null; netPnlUsd: number; feesUsd: number; fundingUsd: number;
  rMultiple: number | null;                  // netPnlUsd / plannedRiskUsd; null if unplanned
  entrySlippagePct: number | null;           // vs plannedSnapshot.referencePrice, signed adverse-positive
  sizeDeviationPct: number | null;
  maePct: number; mfePct: number;            // from 1h klines between first entry and last exit fill
  exitKind: ExitKind; followedPlan: boolean; // exit matched plan's stop/target/time within tolerance
}

export interface AggregateStats {
  venue: ManualTradeVenue; closedTrades: number; winRate: number | null;
  expectancyR: number | null; totalNetPnlUsd: number; maxDrawdownR: number | null;
  adherenceRate: number | null;              // planned & followedPlan / closedTrades
  byRule: Record<string, { closed: number; expectancyR: number | null; netPnlUsd: number }>;   // key "<ruleId>@<first 8 chars of ruleHash>" so rule versions never blend
  byOrigin: Record<PlanOrigin, { closed: number; expectancyR: number | null; netPnlUsd: number }>;  // "persona" added in revision 3; every key always present, zero-filled
  /** Rule-origin trades only, grouped by the AI's stance on their plan. Answers "does the AI's opinion predict outcomes?" */
  byAiStance: Record<AiStance | "none", { closed: number; expectancyR: number | null; winRate: number | null }>;
  /** Revision 3. Closed persona-origin trades whose decision picked another channel's plan, grouped by that
   *  plan's rule: key = `basedOnRuleKey` ("<ruleId>@<first 8 chars of ruleHash>", same format as `byRule`).
   *  Answers "which rules does the persona actually pick, and how do those picks do?" Persona ideas of the
   *  persona's own (no `basedOnPlanId`) are not counted here — they appear only in `byOrigin.persona`.
   *  It counts *closed trades*, not decisions: decisions that were never executed live in `data/decisions/`. */
  chosenByPersona: Record<string, { closed: number; expectancyR: number | null; netPnlUsd: number }>;
}

export function liveView(t: ManualTrade, pos: SyncResult["positions"][number] | null, thesis: ThesisState, now: number, lastSyncAt: number, staleAfterMs: number): LiveTradeView;
export function reviewClosedTrade(t: ManualTrade, klines1h: readonly Kline[]): ClosedTradeReview;
export function aggregate(reviews: readonly ClosedTradeReview[], venue: ManualTradeVenue): AggregateStats;
```

### 5.10 Daily backtest and Gate D0 — `src/backtest-daily/`

Canonical declarations (§5.10a gives the normative behavior behind each):

```ts
export interface SimTrade { planId: string; ruleId: string; symbol: string; decisionDay: string; entryTime: number; exitTime: number;
  entryPrice: number; exitPrice: number; exitKind: "stop" | "target" | "time";
  netPnlUsd: number; riskUsd: number; rMultiple: number; fundingUsd: number; feesUsd: number; }

/** Pure. See §5.10a "Simulation". */
export function simulatePlan(plan: Extract<TradePlan, { kind: "plan" }>, klines1h: readonly Kline[], funding: readonly SourceRow[],
  maxHoldDays: number, slippageBps: number, cutoffMs: number): SimTrade | { kind: "unfilled"; reason: string };

/** Fixed in code, not CLI-configurable. Changing either is a reviewed code change. */
export const HOLDOUT_START_MS: number;   // Date.parse("2025-09-16T00:00:00Z")
export const HOLDOUT_END_MS: number;     // Date.parse("2026-09-15T23:59:59.999Z")

export interface LedgerEntry { time: number; ruleId: string; ruleHash: string; rulesFileCommit: string; command: string;
  holdoutStart: number; holdoutEnd: number; seed: number; slippageBps: number; }

export interface GateD0Report {
  schemaVersion: 2; generatedAt: number; command: string; ruleId: string; ruleHash: string; rulesFileCommit: string;
  holdoutStart: number; holdoutEnd: number;
  ruleEvaluationIndex: number;              // 1-based count of ledger entries for this ruleId, including this run
  globalEvaluationIndex: number;            // 1-based count of ALL ledger entries for this holdout window, including this run
  alpha: number;                            // 0.10 / globalEvaluationIndex
  closedTrades: number; decisionDaysWithTrades: number; meanR: number; bootstrapCi90: [number, number];
  permutationPValue: number; permutationRunsCompleted: number;
  topSymbolShare: number; maxDrawdownR: number; seed: number; slippageBps: number; unfilledCount: number;
  holdoutTradeR: number[];                  // per-trade R in exit-time order — Gate D1 input (with holdoutTradeDays)
  holdoutTradeDays: string[];               // decisionDay per trade, index-aligned with holdoutTradeR (clusters for D1)
  symbols: { symbol: string; firstKlineTime: number }[];
  historyCoverage: Record<string, { from: number; to: number; rows: number }>;
  verdict: "edge_confirmed" | "no_edge" | "insufficient_data" | "holdout_exhausted" | "refused";
  verdictReason: string;
}

/** Pure given its inputs; ledger I/O happens in the CLI before this is called (see ledger rules in §5.10a). */
export function runGateD0(trades: readonly SimTrade[], permutation: { meanRs: readonly number[]; runsAttempted: number },
  opts: { ruleId: string; ruleHash: string; rulesFileCommit: string; ruleSymbolCount: number;
    ruleEvaluationIndex: number; globalEvaluationIndex: number; seed: number; resamples: number; slippageBps: number;
    unfilledCount: number; symbols: GateD0Report["symbols"]; historyCoverage: GateD0Report["historyCoverage"];
    command: string; now: number }): GateD0Report;
```

`runGateD0` verdict order (first match decides):
1. `ruleEvaluationIndex > 3` → `holdout_exhausted`;
2. `closedTrades < 30` or `decisionDaysWithTrades < 20` → `insufficient_data`;
2b. `permutationRunsCompleted < 900` → `insufficient_data`;
3. `meanR <= 0` → `no_edge`;
4. `bootstrapCi90[0] <= 0` (day-clustered bootstrap, §5.10a) → `no_edge`;
5. `permutationPValue > alpha` → `no_edge`;
6. `topSymbolShare > 0.60` (only when the rule has ≥2 symbols) → `no_edge`;
7. `maxDrawdownR > 10` → `no_edge`;
8. else `edge_confirmed`.

The ledger line is appended **before** simulation starts (§5.10a), so a run that crashes still consumes budget.

```ts
export interface GateD1Report {
  schemaVersion: 1; generatedAt: number; command: string; ruleId: string; ruleHash: string; forwardOnly: boolean;
  closedPaperTrades: number; calendarDays: number; expectancyR: number | null; adherenceRate: number | null;
  d0Block30P10: number | null;          // null iff forwardOnly
  unexplainedIncompleteDays: number;    // incomplete-report days touching the rule's features, minus dates listed in docs/validation/d1-<ruleId>.md
  verdict: "paper_passed" | "not_yet" | "failed";
  verdictReason: string;
}

/** Pure. Reviews must all be venue "paper" and ruleId-matching (throws Error otherwise).
 *  d0Holdout = holdoutTradeR + holdoutTradeDays from the rule's passing gate-d0 artifact (ignored if forwardOnly). */
export function runGateD1(reviews: readonly ClosedTradeReview[], opts: { ruleId: string; ruleHash: string; forwardOnly: boolean;
  firstPaperEntryTime: number; now: number; d0Holdout: { r: readonly number[]; days: readonly string[] } | null; unexplainedIncompleteDays: number;
  seed: number; resamples: number; command: string }): GateD1Report;
```

### 5.10a Backtest data, simulation and statistics (normative, Phase 4)

This section closes contract gaps found before implementation. Where it is more specific than §5.10, §8 or §10.3, it wins.

**Evidence that shapes it:**
- The repo has no seeded PRNG (`rg "mulberry|PRNG" src` finds nothing).
- Funding settlement times are per row (`fundingRateTimestamp`, `src/research/sources/bybit-funding.ts:66`), not fixed 00/08/16 UTC.
- The existing concentration metric counts **positive** P&L only (`src/strategy/walkforward.ts:409-414`).
- The seeded macro calendar only covers the rest of 2026 (`data/manual/macro-calendar.json`).
- Farside answers HTTP 403 to Node (Phase 1 live smoke).

#### History store — `src/backtest-daily/history-store.ts`

```ts
/** One file per source: data/history/<sourceId>.json (gitignored), rows with availableAt set per §10.3. */
export interface HistoryFile { sourceId: SourceId; builtAt: number; coverage: { from: number; to: number }; rows: SourceRow[]; }

/** Pure. Point-in-time view at decision time T: for each source, rows with availableAt ≤ T.
 *  The snapshot's fetchedAt = the newest such row's availableAt (NOT T), so buildFeatures' staleness check
 *  flags gaps in history exactly as it would live. No rows ≤ T → status "unavailable", detail "no history before T".
 *  Manual sources (macro calendar, unlocks) get an _meta asOf row equal to T's UTC date (schedules are known ahead, §10.3). */
export function snapshotsAt(history: readonly HistoryFile[], decisionTime: number): SourceSnapshot[];
```

- `scripts/backfill-history.ts` (`npm run backfill -- --from 2024-01-01 --to <date>`) builds the files for `config.symbols`:
  - Bybit 1d and 1h klines (paged via `fetchKlines`, §5.14)
  - Bybit funding (paged by `endTime`)
  - Bybit instruments (current filters, A20)
  - DefiLlama stablecoins, Fear & Greed
  - FRED CPI release dates (needs `FRED_API_KEY`)
  - FOMC statement times from `data/manual/fomc-history.json`, committed: 2024–2026 meetings, each citing the federalreserve.gov calendar page it was taken from
  - Farside **only** from the owner CSVs `data/manual/farside-<btc|eth>.csv`
- **Failures:** a source that cannot be backfilled is written with `rows: []` and its reason in the backfill summary. Features that need it are `missing`, and rules using them are `not_evaluable` on every day. Nothing is synthesized.
- **Symbols (A8):** each Bybit history file records the symbol's first kline time; days before it have no data for that symbol.

#### Replay loop — `src/backtest-daily/replay.ts`

```ts
export interface ReplayOptions { rule: RuleDefinition; history: readonly HistoryFile[]; plannerConfig: PlannerConfig;
  firstDecisionDay: string; lastDecisionDay: string;  // inclusive, UTC dates; decision time = <day>T00:15:00Z
  cutoffMs: number;                                   // simulation may not read any 1h bar with t + 1h > cutoffMs
  slippageBps: number; }                              // per side, default 5 (§8.1 costs + A21)
export interface ReplayResult { trades: SimTrade[]; unfilled: { day: string; symbol: string; reason: string }[];
  outcomes: { day: string; symbol: string; result: RuleOutcome["result"] }[]; eligibleDays: Record<string, string[]>; }
/** Pure. For each decision day and each rule symbol: snapshotsAt → buildFeatures → evaluateRule → planTrade
 *  (openTradeCount 0, breaker not tripped, liveClosedTradesForRule 0, ladderReset true, instrument from history) → simulatePlan.
 *  One open simulated trade per rule+symbol: a trigger while that symbol's previous sim trade is still open is skipped
 *  (recorded as unfilled "position already open"). eligibleDays[symbol] = days whose 1h bars cover decision day through
 *  decision + maxHoldDays within cutoffMs — used by the permutation control. */
export function replayRule(opts: ReplayOptions): ReplayResult;
```

#### Simulation — `simulatePlan` (canonical signature in §5.10)

- **Entry:** the open of the first 1h bar with `t ≥ decisionTime`, adjusted adversely by `slippageBps` (long pays more).
  Quantity, stop and target come from the plan: levels are **not** re-anchored to the fill.
- **Bars:** each bar after entry, starting with the entry bar itself, is checked in order.
  - **Gap through a level at the open:** long `o ≤ stop` → exit at `o` (worse than the stop), `stop`. Long `o ≥ target` → exit at `target` (no gap bonus), `target`. Short mirrored.
  - **Inside the bar:** `l ≤ stop` and `h ≥ target` → `stop` (AC-20). Only `l ≤ stop` → exit at `stop`. Only `h ≥ target` → exit at `target`.
- **Time exit:** at the close of the last bar with `t + 1h ≤ entryBarTime + maxHoldDays·24h`.
- **Costs:** every exit price is adjusted adversely by `slippageBps`. Fees: taker 0.055% of notional per side.
- **Funding:** for each funding row with `entryTime < ts ≤ exitTime`, `fundingUsd −= side · rate · qty · markAt(ts)`, where `side` is +1 long / −1 short and `markAt(ts)` is the close of the 1h bar containing `ts`. AC-21's numbers use notional directly.
- **R:** `netPnlUsd = gross − fees + fundingUsd`, `rMultiple = netPnlUsd / plan.riskUsd`.
- **Exit time:** a gap through a level at the open exits at that bar's open time; an intrabar stop/target touch exits at the bar's
  **close** time (the fill happened somewhere inside the hour, so any funding settlement in that hour is charged — conservative).
- **Funding completeness:** the symbol's funding history must cover the hold — from the last settlement at or before entry to the
  first at or after exit, with no two consecutive settlements more than 8 h + 1 min apart (the longest Bybit interval). A settlement
  inside the hold with no 1h bar to price it is never skipped. Either case → `unfilled` with reason containing `gap`.
- **Unfilled** (never guessed): no bar at or after decision time, a missing bar before exit (gap > 1h in the series), any needed bar
  beyond `cutoffMs`, or incomplete funding as above.

#### Statistics — `src/backtest-daily/stats.ts` (pure)

- **PRNG:** `mulberry32(seed)`, returning floats in [0, 1). The default seed is 20260917 and is recorded in every artifact.
- **Clusters.** Observed trades are grouped by `decisionDay`; a cluster is all trades opened from the same decision day (they share
  that day's market-wide features and are correlated). `decisionDaysWithTrades` = number of clusters.
- **Bootstrap (day-clustered):** `resamples` (10 000) times, draw as many clusters as observed, with replacement, and take the mean R
  over all trades in the drawn clusters. The CI90 is `[percentile(means, 0.05), percentile(means, 0.95)]` using `percentile` from
  `src/strategy/walkforward.ts:109`. Per-trade i.i.d. resampling is not allowed: it would understate uncertainty for correlated trades.
- **Permutation control (exposure-matched):** 1 000 runs. Each run keeps the observed cluster structure exactly:
  - For every observed cluster (its set of symbols), draw one holdout day uniformly from that cluster's **fillable days**, and
    simulate those same symbols on that day with a plan built the same way (same side, `stopAtrMultiple`, `targetRMultiple`,
    `maxHoldDays`, planner, costs). The null therefore has the rule's own symbol mix, trade count and same-day clustering — only
    the timing is random.
  - **Fillable days** of a cluster: days in `eligibleDays` for **all** its symbols on which, for every symbol, the planner returns
    `kind: "plan"` and `simulatePlan` fills. They are computed once per distinct symbol set before any run. Observed trades exist
    only on such days (a rejected or unfilled plan is never a trade), so conditioning the null on them compares like with like;
    without it, days rejected for size (common with small capital) made nearly every run fail and the control could never complete.
  - A cluster whose symbol set has **no** fillable day fails every run → 0 completed runs → `insufficient_data` (step 2b). Fail closed.
  - (Revised 2026-09-17: the earlier "redraw up to 5 attempts per cluster" produced 0 of 1 000 completed runs for a 128-trade rule
    on real history.)
  - `p = (1 + #{completed runs with meanR ≥ observed}) / (1 + completedRuns)`. If fewer than 900 runs complete → `insufficient_data` (step 2b).
- **Concentration:** `topSymbolShare` uses the positive-P&L definition of `src/strategy/walkforward.ts:412-414`.
- **Drawdown:** `maxDrawdownR` is the largest peak-to-trough of cumulative R in exit-time order.

#### Windows and leakage

- **Dev mode:** decision days from `2024-01-11` through the last day `d` with `d + maxHoldDays + 1 day < holdoutStart`, and `cutoffMs = holdoutStart`.
  - Trades cannot reach the holdout. AC-22's assertion (`entryTime ≥ holdoutStart` → non-zero exit) stays as a second line of defense.
  - Dev writes `data/validation/daily/dev-<ruleId>-<date>.json` with the same statistics and `verdict: "dev_only"`, and never touches the ledger.
- **Holdout mode:** decision days from `HOLDOUT_START_MS` to `HOLDOUT_END_MS`, `cutoffMs = HOLDOUT_END_MS + (maxHoldDays + 1)·24 h`, but never later than now minus 1 h.
  The CLI has no flags that change the window. It refuses (exit 1, no ledger line, artifact `verdict: "refused"` not written) when:
  - `rule.forwardOnly` is true, or `rule.origin !== "rules-file"`;
  - `research-rules.json` has uncommitted changes (`git diff --quiet HEAD -- research-rules.json` fails) or git is unavailable — the
    rule under test must exist in a commit, recorded as `rulesFileCommit` (pre-registration, A24);
  - the ledger contains any entry whose `holdoutStart`/`holdoutEnd` differ from the constants (a changed window never shares a
    ledger silently: a new window requires moving the old ledger to `holdout-ledger-<oldStart>.jsonl` in a reviewed commit);
  - the ledger file is unparseable (fail closed — never treated as empty).

#### Ledger and multiple testing

- **Ledger** `data/validation/daily/holdout-ledger.jsonl` (committed): one `LedgerEntry` per holdout run, appended **before**
  simulation starts, so crashes still consume budget.
- **Per-rule cap:** `ruleEvaluationIndex` counts entries with this `ruleId` (any hash); the 4th and later runs are `holdout_exhausted`.
- **Global alpha:** `alpha = 0.10 / globalEvaluationIndex`, where `globalEvaluationIndex` counts **every** entry against this holdout
  window, across all rule ids. Renaming a rule therefore gains nothing: each additional test on the same holdout raises the bar for
  every later test (Bonferroni over the whole family).
- The ledger is append-only by convention and reviewed in git; editing or deleting lines is visible in history and is out of policy.
- **Gate modes use fixed inputs** (added after the Phase 4 independent verification found two bypasses): in `holdout` and
  `d1-check` mode the CLI rejects `--rules-path`, `--history-dir`, `--reports-root`, `--journal-path`, `--artifacts-dir`,
  `--ledger-path`, `--docs-validation-dir`, `--seed`, `--resamples` and `--permutation-runs`; they exist for `dev` only.
  `--slippage-bps` is accepted in gate modes only when ≥ 5 (costs may only become more conservative). The pre-registration git
  checks run against the rules file actually loaded, and an untracked file counts as uncommitted.
- **AI ids in d1-check:** `ai-analyst-<hash8>` selects trades whose full `ruleHash` starts with that 8-char prefix; rules-file ids
  always match the full hash exactly. **(Revision 3)** `persona-<hash8>` behaves identically: treated as `forwardOnly`, hash taken
  from the id prefix, `d0Holdout` null, minimum 60 closed paper trades (§8.5).

#### d1-check

- **Rule and hash:** the rule is loaded from `research-rules.json`. `ai-analyst-*` ids are treated as `forwardOnly`, with the hash taken from the id.
- **Reviews:** closed `paper` trades with that `ruleId` **and** that `ruleHash`, so trades from a previous rule version don't count.
- **`d0Holdout`:** `holdoutTradeR` and `holdoutTradeDays` from the newest `gate-d0-<ruleId>-*.json` with `verdict: "edge_confirmed"` **and** `ruleHash` equal to the current hash; otherwise null.
- **`unexplainedIncompleteDays`:** UTC days from the first paper entry to now whose `reports/<day>.json` has any non-ok source feeding a feature the rule references. A missing report counts as incomplete. Dates listed in `docs/validation/d1-<ruleId>.md` as lines `- YYYY-MM-DD: <reason>` are subtracted.

`runGateD1` verdict order (first match decides):
1. `forwardOnly === false` and `d0Holdout` is null or has no trades → `failed` (no D0 pass to compare against);
2. `closedPaperTrades < minTrades` (30, or 60 if `forwardOnly`) or `calendarDays < 45` → `not_yet`;
3. `expectancyR <= 0` → `failed`;
4. `!forwardOnly && expectancyR < d0Block30P10` → `failed`. `d0Block30P10` is the 10th percentile of `resamples` (10 000) means, each computed by drawing whole decision-day clusters of the D0 holdout trades with replacement (same day grouping as the D0 bootstrap, §5.10a) until at least 30 trades are drawn, seeded — never per-trade i.i.d.;
5. `adherenceRate < 0.90` → `failed`;
6. `unexplainedIncompleteDays > 0` → `not_yet`;
7. else `paper_passed`.

### 5.11 Config additions — `src/config.ts`

```ts
export interface ManualTradingConfig {
  maxLeverage: number;            // integer 1..5, default 2
  liveLadderCap: number;          // integer 1..maxLeverage, default 2
  // riskPerTradePercent (existing field) is validated <= 1 whenever `manual` is present (revision 1 hard cap)
  marginBudgetPercent: number;    // (0,100], default 25
  maintenanceMarginRate: number;  // default 0.005
  minLiqToStopRatio: number;      // >= 1.5, default 2.0
  roundTripFeePercent: number;    // default 0.11
  maxOpenManualTrades: number;    // integer 1..5, default 3
  decisionTimeUtc: "00:15";       // fixed in revision 1
  staleAfterMs: number;           // dashboard sync staleness, default 120_000
  syncIntervalMs: number;         // live sync cadence, default 30_000, >= 10_000
  journalStartTime: string | null;// ISO-8601 UTC; required for live sync (§5.8a), default null
  fundingSignVerified: boolean;   // default false; owner sets true after §12.13
  breakerResetAt: string | null;  // ISO-8601 UTC; owner-set to clear drawdown/consecutiveLosses latches (§5.8a), default null
  journalPort: number;            // default 3082
  notifyOnReport: boolean;        // default false; desktop notification when research:daily writes a report (§5.16), overridable per run with --notify
}
// Config gains `manual?: Partial<ManualTradingConfig>`; loadConfig validates and throws `ConfigError` (src/config.ts:176) on violation.

export interface AiAnalystConfig {
  enabled: boolean;               // default false until the owner turns it on
  provider: "claude-cli" | "anthropic-api"; // default "claude-cli" (owner's subscription, via the local CLI); "anthropic-api" pays per call via @anthropic-ai/sdk
  cliPath: string | null;         // default null: resolves join(dirname(process.execPath), "claude") if it exists, else "claude" (PATH lookup). Only consulted when provider is "claude-cli"
  model: string;                  // default "claude-opus-5"
  effort: "low" | "medium" | "high" | "xhigh" | "max";  // default "high"
  maxTokens: number;              // default 32000 (request is streamed)
  webSearchMaxUses: number;       // integer 0..10, default 5; 0 disables the web search tool
  maxIdeasPerDay: number;         // integer 0..3, default 3
  monthlyBudgetUsd: number;       // > 0, default 15
  inputUsdPerMTok: number;        // default 5    (claude-opus-5 list price, cached 2026-06-24)
  outputUsdPerMTok: number;       // default 25
  webSearchUsdPerRequest: number; // default 0.01 — UNVERIFIED, owner confirms at implementation (§13 A16)
  channelStatus: "experimental" | "paper-passed";  // owner-edited after Gate D1 for the AI channel (§8.4)
  passedPromptHash: string | null;                  // the full promptVersionHash that passed D1; required non-null when channelStatus is "paper-passed"
  timeoutMs: number;              // default 600_000
}
// Config gains `ai?: Partial<AiAnalystConfig>`; credential read from CLAUDE_CODE_OAUTH_TOKEN or
// ANTHROPIC_API_KEY (provider "claude-cli"), or from ANTHROPIC_API_KEY / the SDK default credential
// chain (provider "anthropic-api") — never from config.json, either way.

// ── Revision 3 ───────────────────────────────────────────────────────────────────────────────
export interface PersonaConfig {
  executionWindowMs: number;      // > 0, default 21_600_000 (6 h). The Plan Report's execute window: decidedAt + this (§13 A29)
  maxEntryGapAtr: number;         // > 0, default 0.25. Gap rule: skip the entry if |mark − referencePrice| > this × atr14d (§13 A30)
  channelStatus: "experimental" | "paper-passed";  // default "experimental"; owner-edited after the persona channel's Gate D1 (§8.5)
  passedSkillHash: string | null; // default null; loadConfig throws ConfigError when channelStatus is "paper-passed" and this is null
  ownerTimeZone: string;          // IANA zone for the Plan Report's second clock column, default "America/Argentina/Buenos_Aires" (UTC−3)
  decisionsRoot: string;          // default "data/decisions"
  skillRoot: string;              // default ".claude/skills/crypto-fundamental-analyst" — the skillHash input root (§5.15)
}
// Config gains `persona?: Partial<PersonaConfig>`; loadConfig validates and throws ConfigError
// (src/config.ts:176) on violation. There is no `enabled` flag: the channel is a CLI the owner runs by
// hand, so not running it is how it stays off. No credential and no network is involved (§5.15).
```

### 5.12 CLIs and scripts (`package.json`)

```
"research:daily":  "node --experimental-strip-types scripts/research-daily.ts --config ./config.json"
"snapshot:daily":  "node --experimental-strip-types scripts/snapshot-daily.ts --config ./config.json"
"backfill":        "node --experimental-strip-types scripts/backfill-history.ts --config ./config.json"
"backtest:daily":  "node --experimental-strip-types scripts/backtest-daily.ts --config ./config.json"
"journal":         "node --experimental-strip-types src/server/journal-server.ts --config ./config.json"
"decide":          "node --experimental-strip-types scripts/decide-daily.ts --config ./config.json"
```

- `snapshot:daily [--date YYYY-MM-DD] [--revision N] [--snapshot-root DIR]` (Phase 1; later called internally by `research:daily`) — scheduled decision time is `<date>T00:15:00Z` (default: today UTC). **Effective decision time** (used for features, reports and plans): if every snapshot's `fetchedAt` lies in `[scheduled, scheduled + 2h]` it is the latest `fetchedAt` (`mode: "live"`); otherwise it is the scheduled time (`mode: "scheduled"`, e.g. backdated runs). Without this, sources whose `availableAt` is `fetchedAt` would always be filtered by P2 in live runs. Output adds `scheduledDecisionTime`, `decisionTime`, `decisionMode`; runs every adapter for `config.symbols`, writes snapshots, prints `{ sources: [{sourceId,status,statusDetail,rows}], features: FeatureVector[] }` as JSON to stdout. Exit 0 whenever snapshots were written (any status); exit 3 if any snapshot for the date exists and no `--revision`; exit 4 if decision time is in the future.
- `research:daily [--date YYYY-MM-DD] [--refetch] [--notify]` — exit 0 on report written (complete or incomplete); exit 2 on rule-set validation failure; exit 3 if report for the date exists and `--refetch` not given. `--notify` (or `manual.notifyOnReport: true`) fires a best-effort desktop notification once the report is written (§5.16).
- `backtest:daily --rule <id> --mode dev|holdout|d1-check` — `dev` never touches holdout data (asserts every sim trade's `entryTime < holdoutStart`); `holdout` runs `runGateD0` and writes `data/validation/daily/gate-d0-<ruleId>-<date>.json`; `d1-check` reads `manual-journal.json`, the rule's latest `edge_confirmed` gate-d0 artifact and `docs/validation/d1-<ruleId>.md`, runs `runGateD1`, and writes `data/validation/daily/gate-d1-<ruleId>-<date>.json`. Exit code 0 only when the verdict is `edge_confirmed` / `paper_passed`; 1 otherwise.
- `journal` HTTP: `GET /` (journal.html), `GET /events` (SSE: `live` every sync, `trade` on change, `: keepalive` 30s),
  `GET /api/trades?venue=`, `GET /api/review/:tradeId`, `GET /api/stats?venue=`, `POST /api/trades/:id/link {planId}`,
  `POST /api/paper/entry {planId, fillPrice, time}`, `POST /api/paper/exit {tradeId, fillPrice, time, exitKind}`,
  `PATCH /api/trades/:id/notes {notes}`,
  `PATCH /api/trades/:id/exit-kind {exitKind: "thesis_invalidated"}` (409 unless the current `exitKind` is `discretionary` and the trade is closed),
  `GET /api/state` → `{ liveSync: "enabled" | "disabled"; liveSyncReason: string; lastSync: SyncResult | null; fundingSignVerified: boolean; breaker: { tripped: boolean; trigger: string | null; details: string }; openViews: LiveTradeView[] }`,
  `GET /api/reviews.csv` (Phase 7, §5.16) → `text/csv`, one row per closed trade (both venues), `Content-Disposition: attachment; filename="reviews-<today>.csv"`.
  Server binds `127.0.0.1` only. All error responses are `{ error: string }` with status 400 (bad body), 403 (Host/Origin), 404 (unknown id), 409 (state conflict).
- `research:daily` order of operations: snapshots → features → rule outcomes → rule plans → `buildReport` → write
  `reports/<date>.json` + `.md` (**the rules report is persisted before any AI call**) → if `ai.enabled`: `runAiAnalyst`
  → `attachAiAnalyst` → rewrite both report files. An AI failure never deletes or alters the already-written rules report content.
- `research:daily --no-ai` skips the AI step for that run (section status `"disabled"`, reason `"--no-ai"`).
- **(Revision 3)** `decide --date YYYY-MM-DD [--mode plan|manage|review] [--trade <tradeId>] [--input <file>] [--revise] [--decisions-root DIR] [--reports-root DIR] [--journal-path FILE] [--sync-status-path FILE] [--rules-path FILE] [--ai-rules-root DIR] [--skill-root DIR]` —
  reads the `DailyDecisionInput` (or `ManageInput` / `ReviewInput`) as JSON from `--input` or stdin; `--mode`
  defaults to `plan`. `--trade` is **required** for `manage` and `review` (those artifacts are keyed by
  `(date, tradeId)`, §5.15) and rejected for `plan`. Writes only under `persona.decisionsRoot` and `reports/`; one
  invocation handles exactly one trade. Exit codes in §5.15; the
  `--*-root` / `--*-path` flags exist so tests can redirect I/O and are not part of the owner's workflow.

### 5.13 AI analyst — `src/research/ai/`

```ts
export type AiStance = "support" | "caution" | "oppose";

export type AiEvidenceRef =
  | { kind: "feature"; symbol: string; feature: FeatureName; value: number }  // value must match the FeatureVector
  | { kind: "web"; url: string };                                             // url must appear in this call's search results

export interface AiPlanAssessment { planId: string; stance: AiStance; confidence: number; reasons: { text: string; refs: AiEvidenceRef[] }[]; }

export interface AiIdea {
  symbol: string; side: "long" | "short"; thesis: string; catalysts: string[]; refs: AiEvidenceRef[];
  invalidateWhenAny: Condition[]; stopAtrMultiple: number; targetRMultiple: number; maxHoldDays: number; confidence: number;
}

/** Exact shape requested via structured outputs (JSON schema generated from a zod schema, §10.1). */
export interface AiAnalystOutput {
  regimeSummary: string;
  planAssessments: AiPlanAssessment[];
  ideas: AiIdea[];
  openTradeNotes: { tradeId: string; note: string; refs: AiEvidenceRef[] }[];
  risks: string[];
  dataGaps: string[];
}

export interface AiAnalystInput {
  dateUtc: string; decisionTime: number; promptVersionHash: string; systemPrompt: string;
  sources: DailyReport["sources"]; features: FeatureVector[]; outcomes: RuleOutcome[];
  rulePlans: TradePlan[];                                      // origin "rules-file" only
  openTrades: { tradeId: string; symbol: string; side: "long" | "short"; ruleId: string | null; thesis: ThesisState; heldHours: number; unrealisedR: number | null }[];
  configSymbols: string[];
}

export type AiCallResult =
  | { kind: "ok"; output: AiAnalystOutput; webResults: { url: string; title: string; pageAge: string | null }[];
      usage: { inputTokens: number; outputTokens: number; webSearchRequests: number }; servedByModel: string; rawResponsePath: string;
      listCostUsd?: number }   // the provider's own list-price estimate, when it reports one (claude-cli's total_cost_usd); undefined for anthropic-api
  | { kind: "failed"; reason: "no_api_key" | "api_error" | "rate_limited" | "timeout" | "refusal" | "max_tokens" | "schema_invalid";
      detail: string; usage: { inputTokens: number; outputTokens: number; webSearchRequests: number } | null };

/** Port. Implementations MUST resolve (never reject). */
export interface AiClientPort { analyze(input: AiAnalystInput): Promise<AiCallResult>; }

/** src/research/ai/anthropic-client.ts (provider "anthropic-api"). Uses @anthropic-ai/sdk streaming request with:
 *  model/effort/maxTokens from cfg, thinking {type:"adaptive"}, structured output format from the zod schema, tool
 *  web_search_20260209 with max_uses = webSearchMaxUses (omitted when 0), refusal fallback fallbacks:"default"
 *  (beta server-side-fallback-2026-07-01). Checks stop_reason before reading content. Writes the full raw response
 *  to data/snapshots/<date>/ai-analyst.raw.json (write-once, shared helper src/research/ai/raw-response.ts). */
export function createAnthropicAiClient(cfg: AiAnalystConfig, snapshotRoot: string): AiClientPort;

/** src/research/ai/claude-cli-client.ts (provider "claude-cli", the default). Runs the same analysis through the
 *  locally installed `claude` CLI under the owner's subscription instead of the Anthropic API. Credential check
 *  before spawning: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, else `failed: no_api_key`; when the OAuth token is
 *  set, ANTHROPIC_API_KEY is deleted from the child's environment so the subscription is always used. The user
 *  content (same JSON the SDK adapter sends) is written to the child's stdin; cwd is an empty temp dir removed
 *  after. Invocation (args array, no shell):
 *  `-p --output-format stream-json --verbose --no-session-persistence --setting-sources "" --permission-mode dontAsk
 *  --max-turns <2 + 2×webSearchMaxUses> --model <cfg.model> --effort <cfg.effort> --json-schema <the JSON schema
 *  string> --system-prompt <input.systemPrompt>`, plus `--tools WebSearch --allowedTools WebSearch` when
 *  webSearchMaxUses > 0 (else `--tools ""`) — `--allowedTools WebSearch` is required for the CLI to actually use the
 *  tool under `--permission-mode dontAsk`. `--bare` is never passed (it ignores the OAuth token). The child is
 *  killed after cfg.timeoutMs → `failed: timeout`; a spawn error (ENOENT etc.) → `failed: api_error`.
 *  Output is JSONL: one event per line, a terminal `result` event (not necessarily the last line — trailing
 *  `system` events can follow it) carries `subtype`, `is_error`, `structured_output`, `result` (string),
 *  `total_cost_usd` (the CLI's own list-price estimate, returned as `listCostUsd`) and `modelUsage` (one entry per
 *  model actually used). Web search results come from every `user` event whose `tool_use_result` is an object with
 *  `results[]`: each `results[N].content[]` item is `{title, url}` (the "Links: [...]" string form elsewhere in the
 *  event is not parsed — the object form is authoritative). Usage sums every `modelUsage[*]` entry:
 *  `inputTokens + cacheReadInputTokens + cacheCreationInputTokens` → inputTokens, `outputTokens` → outputTokens,
 *  `webSearchRequests` → webSearchRequests (the terminal event's top-level `usage.server_tool_use.
 *  web_search_requests` is NOT used — it stays 0 even when a search ran). `servedByModel` = `modelUsage` keys
 *  joined by ",". Result mapping: `subtype "success"` + `is_error false` + `structured_output` present → zod
 *  safeParse (schema_invalid on failure) → ok. `subtype "error_max_structured_output_retries"` → schema_invalid;
 *  `"error_max_turns"` → max_tokens (closest union member). `is_error true` with the result text matching /401|auth/i
 *  → api_error ("authentication failed — check CLAUDE_CODE_OAUTH_TOKEN"), /429|rate limit/i → rate_limited,
 *  /refus/i → refusal, else api_error. A non-zero exit with no result event → api_error with the last stderr line.
 *  Every stdout event is written, as a JSON array, write-once to the same raw-response path as the SDK adapter. */
export function createClaudeCliAiClient(cfg: AiAnalystConfig, snapshotRoot: string): AiClientPort;

export interface AiRejectedItem {
  path: string;                     // e.g. "ideas[1]", "planAssessments[0].reasons[2]"
  reason: "unverifiable_feature" | "unverifiable_web" | "unknown_plan" | "unknown_trade" | "symbol_not_configured"
        | "out_of_range" | "over_limit" | "no_evidence";
}

/** Pure. Feature refs verify iff the symbol's FeatureValue is kind "value" and |value − ref.value| <= 1e-9 × max(1, |value|).
 *  Web refs verify iff url is string-equal to a webResults url. An assessment reason / trade note with any failing ref is
 *  dropped; an assessment left with zero reasons is dropped; an idea with any failing ref, zero refs, a symbol not in
 *  configSymbols, confidence ∉ [0,1], stopAtrMultiple ∉ (0,10], targetRMultiple ∉ (0,20], or maxHoldDays ∉ 1..10 is dropped.
 *  Ideas beyond maxIdeas (in output order, after dropping) are dropped as "over_limit". */
export function verifyAiOutput(out: AiAnalystOutput, input: AiAnalystInput, webResults: readonly { url: string }[], maxIdeas: number):
  { output: AiAnalystOutput; rejected: AiRejectedItem[] };

/** SHA-256 over canonical JSON of { systemPrompt, outputJsonSchema, model, effort, maxTokens, webSearchMaxUses, maxIdeasPerDay, provider }.
 *  Every setting that changes AI behaviour is included, so changing any of them requires a fresh Gate D1 (§8.4) —
 *  `provider` is included because switching between claude-cli and anthropic-api is itself a behaviour change.
 *  Budget, pricing, cliPath, timeout and channelStatus/passedPromptHash are excluded (they do not change the output).
 *  First 8 hex chars form the AI rule id `ai-analyst-<hash8>`. */
export function promptVersionHash(systemPrompt: string, outputJsonSchema: string, cfg: AiAnalystConfig): string;

/** Pure. origin "ai-analyst", forwardOnly true, entryWhenAll [], evidence [], version 1, id `ai-analyst-<hash8>`,
 *  symbols [idea.symbol], side idea.side, description idea.thesis, invalidateWhenAny / stopAtrMultiple / targetRMultiple /
 *  maxHoldDays copied from the idea,
 *  status = (cfg.channelStatus === "paper-passed" && cfg.passedPromptHash === promptHash) ? "paper-passed" : "experimental". */
export function aiIdeaToRule(idea: AiIdea, promptHash: string, cfg: AiAnalystConfig): RuleDefinition;

export interface AiAnalystSection {
  status: "pending" | "ok" | "unavailable" | "skipped_budget" | "disabled";
  // "pending": written by buildReport when ai.enabled, before the AI call; replaced by attachAiAnalyst. A report left
  // "pending" means the process died mid-run; the Markdown then shows "AI analyst: did not complete".
  reason: string;                          // empty only when status is "ok"
  model: string | null; provider: "claude-cli" | "anthropic-api" | null; servedByModel: string | null; promptVersionHash: string | null;
  costUsd: number;                         // real API spend; 0 under provider "claude-cli" (the subscription bills separately)
  monthToDateUsd: number;
  listCostUsd: number;                     // the provider's own list-price estimate; equals costUsd under "anthropic-api"
  regimeSummary: string | null;
  assessments: AiPlanAssessment[];         // verified only
  plans: TradePlan[];                      // origin "ai-analyst", produced by planTrade from aiIdeaToRule(...)
  ideas: AiIdea[];                         // verified ideas, index-aligned with the planTrade calls
  openTradeNotes: AiAnalystOutput["openTradeNotes"];
  risks: string[]; dataGaps: string[];
  rejected: AiRejectedItem[];
}

/** Budget ledger data/ai-usage.jsonl: one line per call attempt {time, dateUtc, model, usage, costUsd, listCostUsd, resultKind}.
 *  monthToDateSpendUsd sums only costUsd (real spend), so provider "claude-cli" calls (costUsd 0) never count
 *  against monthlyBudgetUsd; listCostUsd is informational only. */
export function monthToDateSpendUsd(ledgerPath: string, now: number): number;   // missing file → 0; unparseable line → throws
export function estimateCallCostUsd(usage: { inputTokens: number; outputTokens: number; webSearchRequests: number }, cfg: AiAnalystConfig): number;
// runAiAnalyst computes costUsd = cfg.provider === "claude-cli" ? 0 : estimateCallCostUsd(usage, cfg), and
// listCostUsd = result.listCostUsd ?? costUsd (so the anthropic-api adapter, which never sets listCostUsd, gets
// listCostUsd === costUsd).

/** Orchestrates: budget check → analyze → append ledger line (even on failure, when usage is known) → verify → plan ideas.
 *  Never throws for API/verification/ledger/persistence problems; returns a section with status "unavailable" and
 *  reason instead (e.g. "ledger_write_failed: ...", "ai_rule_persist_failed: ..." — a plan whose rule could not be
 *  persisted write-once is never returned, fail closed).
 *  AI plans use the same PlannerConfig, open-trade count (rule plans count toward maxOpenManualTrades first) and breaker state. */
export function runAiAnalyst(input: AiAnalystInput, port: AiClientPort, cfg: AiAnalystConfig, planner: {
  cfg: PlannerConfig; openTradeCount: number; breakerTripped: boolean; dateUtc: string;
  features: FeatureVector[]; liveClosedTradesForAi: number; ladderResetByBreaker: boolean; ledgerPath: string; now: number;
}): Promise<AiAnalystSection>;
```

For an AI idea, `planTrade` receives a synthesized triggered outcome
`{ ruleId: "ai-analyst-<hash8>", ruleHash: promptVersionHash, symbol, result: "triggered", evidence: <feature refs as {feature: value}> }`
and the rule from `aiIdeaToRule`. `planId = <date>:ai-analyst-<hash8>:<symbol>`; if two verified ideas share a symbol,
`runAiAnalyst` drops the second as `over_limit`. Each AI rule is persisted write-once to `data/ai-rules/<planId>.json`
so later reports can run `evaluateThesis` on open AI-origin trades; a missing file makes that trade's thesis `not_evaluable`.

### 5.14 Trade chart & replay — Phase 3b (owner request 2026-09-16)

A per-trade chart in the journal dashboard, for **live** and **closed** trades of either venue:
- **Card:** direction and leverage, entry, close (or last price), state, P&L.
- **Chart:** real price line, dashed Entry / SL / TP / Liquidation levels, entry and exit markers, and a
  shaded **volatility range**.
- **Replay:** a slider reveals the price candle by candle, with a play animation. Live trades follow the
  newest candle.

The range is **not a forecast**: it carries no direction and is computed only from data closed before entry.

**Evidence.** The existing 1 h kline fetch requests `limit=200` without paging (`src/server/journal-server.ts:430`), while
`maxHoldDays` allows 240 h, so MAE/MFE of long holds would be computed on truncated data. It is replaced by the paged fetch
below for both reviews and charts.

```ts
// src/journal/chart.ts (pure) + src/journal/market-data.ts (I/O)
export type ChartInterval = "15" | "60";

/** I/O. Public Bybit /v5/market/kline, paged backwards with `end` until `startMs` is covered (≤ 1000 bars/request),
 *  deduped by open time, ascending. Resolves null on any HTTP/shape error — never a partial series (P1). */
export function fetchKlines(symbol: string, interval: ChartInterval | "D", startMs: number, endMs: number,
  deps: Pick<AdapterDeps, "fetch" | "sleep">): Promise<Kline[] | null>;

/** Pure. "15" when (exitTime ?? now) − firstEntry ≤ 48 h, else "60". */
export function chooseInterval(firstEntryMs: number, endMs: number): ChartInterval;

/** Pure. Daily σ (fraction) = sample stdev of the last 7 daily log returns using ONLY daily bars whose close time
 *  (t + 24 h) ≤ entryTime. Fewer than 8 such bars → null (band omitted, never guessed). */
export function dailySigmaBeforeEntry(dailyBars: readonly Kline[], entryTimeMs: number): number | null;

/** Pure. For each t ≥ entryTime: d = (t − entryTime) / 24 h; upper_k = entry·exp(k·σ·√d), lower_k = entry·exp(−k·σ·√d), k ∈ {1, 2}. */
export function volatilityBand(entryPrice: number, entryTimeMs: number, sigmaDaily: number, times: readonly number[]):
  { t: number; upper1: number; lower1: number; upper2: number; lower2: number }[];

/** Pure. Candles at or before cursor index are revealed; later ones hidden. cursor clamped to [0, candles.length − 1]. */
export function revealCandles<T>(candles: readonly T[], cursor: number): T[];

export interface TradeChartData {
  tradeId: string; symbol: string; side: "long" | "short"; venue: ManualTradeVenue; status: "open" | "closed";
  origin: "rules-file" | "ai-analyst" | null; ruleId: string | null;
  leverage: number | null;                  // actualLeverage for bybit-live, plannedSnapshot.leverage for paper
  interval: ChartInterval;
  levels: { entry: number; stop: number | null; target: number | null; liquidation: number | null };
  entryTime: number; exitTime: number | null; exitPrice: number | null;
  candles: Kline[];                         // closed bars from firstEntry − 6 bars to (lastExit + 6 bars | now)
  formingCandle: Kline | null;              // open trades only: the current, not-yet-closed bar (drawn dashed)
  band: { sigmaDaily: number; points: ReturnType<typeof volatilityBand> } | null;
  pnl: { kind: "realized" | "unrealized"; usd: number; basis: string } | null;
  dataStatus: "ok" | "unavailable"; dataDetail: string;
}
```

- **P&L.** Closed trades use the journal's `netPnlUsd`. Open trades use the direction-adjusted `(last price − avgEntry) × qty − fees + fundingUsd`.
  - Last price = sync `markPrice` for `bybit-live` when not stale; otherwise the last **closed** candle's close.
  - `basis` names which one was used, e.g. `"mark"` or `"last 15m close"`.
- **Endpoint.** `GET /api/trades/:id/chart` → `TradeChartData`.
  - 404 for an unknown id.
  - Failed kline fetch → 200 with `dataStatus: "unavailable"`, `candles: []`, `band: null`. The UI shows the reason and never draws a line.
  - Closed trades are cached in memory by `tradeId + updatedAt`.
- **Live.** On each SSE `live`/`trade` event the UI refetches the open trade's chart. The slider stays pinned to the newest
  candle unless the owner has dragged it back; a `LIVE` button re-pins it.
- **Replay.** Play reveals 1 candle per 80 ms, starting from the entry candle. Pause, drag and restart are available.
  `prefers-reduced-motion` disables the animation (jumps straight to the end).
  Until the cursor reaches the exit candle of a closed trade, the exit marker, close price and P&L stay hidden; the card
  shows the price at the cursor instead, so the replay can be reviewed without hindsight.
- **Caching.** Closed-trade charts and reviews are cached by `tradeId + updatedAt` only when their kline fetch succeeded;
  a failed fetch is retried on the next request instead of being pinned as unavailable.
- **Channel tabs.** `Rules` / `AI` / `Both` filter the trade list by `origin`; `AI` shows an empty state until Phase 4b.
- **Rendering.** Inline SVG, no new dependencies.
  - Levels are labeled at the left edge: Entry, SL, TP; Liq only when present.
  - The ±2σ band is drawn lighter than ±1σ. The legend reads `Real price`, `Volatility range ±1σ / ±2σ (not a forecast)`.
  - Every dynamic string is HTML-escaped.

### 5.15 Persona decision channel — `src/decision/` (revision 3, Phase 6)

The persona (§4.7) decides; this module validates, sizes, records and renders. **Nothing here calls the
network or an LLM**: the persona is a human-driven Claude Code session, and its output reaches the system
only as a JSON block on stdin. `npm run decide` is the only writer of `data/decisions/` and
`reports/*.decision.md` (P9).

#### Types — `src/decision/types.ts`

```ts
import type { AiEvidenceRef, AiStance } from "../research/ai/types.ts";            // §5.13 shapes, reused verbatim
import type { Condition, RuleDefinition, RuleSet, ThesisState } from "../research/rules.ts";
import type { InstrumentFilter, PlannerConfig, TradePlan } from "../research/planner.ts";
import type { DailyReport } from "../research/report.ts";
import type { FeatureVector } from "../research/types.ts";
import type { ExitKind, ManualTrade } from "../journal/types.ts";
import type { SyncResult } from "../journal/exchange-sync.ts";                     // §5.8
import type { ClosedTradeReview } from "../journal/trade-analytics.ts";
import type { PersonaConfig } from "../config.ts";                                 // §5.11

/** A news item the persona checked. Recorded, never verified by the system (P3, revision 3). */
export interface PersonaNewsItem { title: string; url: string; date: string | null; tag: "confirmed" | "unconfirmed" | "contradicts"; }

/** The persona's opinion of ONE plan in the report. One is required for every kind:"plan" plan. */
export interface PersonaStance { planId: string; stance: AiStance; reasons: string[]; }   // reasons: >= 1 non-empty string

/** Same shape as AiIdea (§5.13) — deliberately, so both non-rule channels are sized by one code path. */
export interface PersonaIdea {
  symbol: string; side: "long" | "short"; thesis: string; catalysts: string[]; refs: AiEvidenceRef[];
  invalidateWhenAny: Condition[]; stopAtrMultiple: number; targetRMultiple: number; maxHoldDays: number; confidence: number;
}

export type PersonaChoice =
  | { kind: "report-plan"; planId: string }        // a kind:"plan" plan of that date's report, either channel
  | { kind: "persona-idea"; idea: PersonaIdea }    // the persona's own idea
  | { kind: "no-trade"; reason: string };          // trimmed length >= 1

export interface DailyDecisionInput {
  dateUtc: string;                 // YYYY-MM-DD, must equal --date
  choice: PersonaChoice;
  stances: PersonaStance[];        // exactly one per kind:"plan" plan in that date's report, any order
  news: PersonaNewsItem[];         // may be empty ("News: not checked")
  rationale: string;               // trimmed length >= 1; rendered as Plan Report §3
}

export type DecisionRejectionCode =
  | "schema_invalid" | "date_mismatch" | "unknown_plan" | "not_a_plan" | "expired" | "rule_changed"
  | "unverifiable_feature" | "web_only_evidence" | "no_evidence" | "symbol_not_configured"
  | "out_of_range" | "missing_stance" | "duplicate_stance" | "empty_reason" | "replan_rejected"
  // --mode manage / --mode review only. One code per distinguishable cause, so a rejection says what to do:
  | "trade_not_found"      // no journal trade with that id at all
  | "trade_not_open"       // --mode manage, trade exists but status !== "open"
  | "trade_not_closed"     // --mode review, trade exists but status !== "closed"
  | "trade_not_planned"    // trade exists in the right state but has no plannedSnapshot (unplanned fill)
  | "thesis_mismatch";     // --mode manage, input.thesis !== the ThesisState the CLI computed
// `not_a_plan` is plan-mode only (the chosen report entry is `kind:"rejected"`); manage/review use the
// four trade-state codes above instead, so "not a plan" never has to mean four different things.

export interface DecisionRejection { code: DecisionRejectionCode; path: string; detail: string; }

export interface DecisionValidation {
  ok: boolean;
  rejections: DecisionRejection[];
  /** Web refs are recorded, never verified: the persona's searches happen in its own session and the
   *  system cannot see them (P3). Always `verified: false`; present so the Plan Report §6 can list them. */
  unverifiedWebRefs: { path: string; url: string }[];
}

export interface OwnerProtocolOrder {
  slot: 1 | 2 | 3; kind: "entry" | "stop" | "take-profit"; action: "buy" | "sell";
  orderType: "market" | "stop-market" | "limit"; price: number | null; quantity: number; reduceOnly: boolean;
}

export interface OwnerProtocol {
  decidedAt: number; executeFrom: number; executeUntil: number;   // executeFrom = decidedAt; executeUntil = decidedAt + persona.executionWindowMs, CAPPED at the chosen report plan's own expiresAt for a "report-plan" choice (buildOwnerProtocol's `capAt`); uncapped for a "persona-idea" (AC-105: a fresh idea carries its own window). Revision-3 fix, AC-134
  referencePrice: number; atr14d: number; maxEntryGapAbs: number; // maxEntryGapAbs = persona.maxEntryGapAtr × atr14d
  entryBand: [number, number];                                    // [referencePrice − maxEntryGapAbs, referencePrice + maxEntryGapAbs]
  venueIntent: "paper" | "live"; leverage: number; marginMode: "isolated";
  orders: OwnerProtocolOrder[];                                   // exactly 3, slots 1..3, stop and take-profit reduceOnly true
  recordVia: "paper-api" | "live-link";                           // "paper-api" iff venueIntent "paper"
  timeExitOnOrBefore: number;                                     // decidedAt + maxHoldDays × 24 h — the hard time exit, planning estimate from decidedAt
  nextReportAt: number;                                           // next <date>T00:15:00Z strictly after decidedAt
  ownerTimeZone: string;                                          // persona.ownerTimeZone, for the Plan Report's second clock
}

export interface DailyDecision {
  schemaVersion: 1; dateUtc: string; revision: number;            // 0 for <date>.json, n for <date>.r<n>.json
  decidedAt: number; skillHash: string;
  reportPath: string; reportSha256: string; reportDecisionTime: number;
  input: DailyDecisionInput; validation: DecisionValidation;
  plan: Extract<TradePlan, { kind: "plan" }> | null;              // null iff choice.kind === "no-trade"
  /** The synthesized persona rule (personaIdeaToRule / reportPlanToPersonaRule) that produced `plan`.
   *  Persisted here — not in data/ai-rules/ — so a later report can run `evaluateThesis` on an open
   *  persona-origin trade and so the plan is reproducible from the artifact alone. Null iff plan is null;
   *  a decision file that cannot be read makes that trade's thesis `not_evaluable` (same rule as §5.13). */
  personaRule: RuleDefinition | null;
  basedOnPlanId: string | null; basedOnRuleKey: string | null;    // non-null iff choice.kind === "report-plan"
  ownerProtocol: OwnerProtocol | null;                            // null iff plan is null
  ownerTimeZone: string;                                          // persona.ownerTimeZone at decide time, on every decision (no-trade included): the Plan Report's second clock column must never fall back to UTC
  disclaimer: "Generated analysis for the owner's review. Not investment advice.";
}

// Manage and review artifacts are keyed by (dateUtc, tradeId), never by date alone: with
// `maxOpenManualTrades` up to 5 the owner can hold several positions at once, and two trades managed on
// the same morning are unrelated records. `tradeId` is therefore part of each artifact's identity, and
// write-once, `--revise` and "effective artifact" are all scoped to that pair (see the artifact table).
export interface ManageInput {
  dateUtc: string; tradeId: string;   // must equal --date and --trade
  action: { kind: "hold" } | { kind: "tighten-stop"; price: number } | { kind: "close-now" };
  thesis: ThesisState; reasons: string[]; news: PersonaNewsItem[];   // reasons: >= 1 non-empty string
}
export interface ManageDecision { schemaVersion: 1; dateUtc: string; tradeId: string; revision: number; writtenAt: number; skillHash: string;
  input: ManageInput; validation: DecisionValidation; tradePlanId: string | null; currentStopPrice: number; disclaimer: DailyDecision["disclaimer"]; }

export interface ReviewInput {
  dateUtc: string; tradeId: string;   // must equal --date and --trade
  rMultiple: number; exitKind: ExitKind; followedPlan: boolean;
  thesisVerdict: "confirmed" | "invalidated" | "inconclusive"; lesson: string;   // trimmed length >= 1
}
export interface ReviewDecision { schemaVersion: 1; dateUtc: string; tradeId: string; revision: number; writtenAt: number; skillHash: string;
  input: ReviewInput; validation: DecisionValidation; computed: ClosedTradeReview; disclaimer: DailyDecision["disclaimer"]; }
```

#### Functions — `src/decision/decide.ts` (pure) and `plan-report.ts` (pure)

```ts
export interface DecisionContext {
  dateUtc: string; report: DailyReport; reportPath: string; reportSha256: string;
  features: FeatureVector[];                 // rebuilt from that date's snapshots at the report's decisionTime
  configSymbols: readonly string[];
  plannerConfig: PlannerConfig;
  personaCfg: PersonaConfig;
  skillHash: string;
  ruleSet: RuleSet;                          // research-rules.json, to re-load a chosen rule plan's rule
  aiRules: Record<string, RuleDefinition>;   // data/ai-rules/<planId>.json, to re-load a chosen AI plan's rule
  journal: readonly ManualTrade[];
  breaker: { tripped: boolean; trigger: string | null; details: string };
  liveClosedTradesForPersona: number; ladderResetByBreaker: boolean;
  instruments: Record<string, InstrumentFilter | null>;
  now: number;                               // = decidedAt
}

/** Pure. Validates the input against the report and the config. Never throws; collects EVERY rejection
 *  (like parseRuleSet, §5.4) so one run tells the persona everything that is wrong. Order of checks does
 *  not short-circuit across independent items. See the rejection table below. */
export function validateDecision(input: DailyDecisionInput, ctx: DecisionContext): DecisionValidation;

export interface ManageContext {
  dateUtc: string; tradeArg: string;            // --trade, as given on the command line
  trade: ManualTrade | null;                    // journal lookup by id; null = not found
  /** The thesis the CLI computed itself: `evaluateThesis(rule, fv)` for that trade's rule, resolved the
   *  same way §5.8a resolves a planId — `research-rules.json` for a rule-origin trade,
   *  `data/ai-rules/<planId>.json` for an AI-origin one, the decision file's `personaRule` for a
   *  persona-origin one. `not_evaluable` when the rule or a feature cannot be loaded (never a guess). */
  computedThesis: ThesisState;
  personaCfg: PersonaConfig; skillHash: string; now: number;
}

export interface ReviewContext {
  dateUtc: string; tradeArg: string;
  trade: ManualTrade | null;
  computed: ClosedTradeReview | null;           // reviewClosedTrade(trade, klines1h); null iff trade is null or open
  personaCfg: PersonaConfig; skillHash: string; now: number;
}

/** Pure, same discipline as validateDecision: never throws, collects every rejection.
 *  Rejection tables under "Manage and review modes" below. */
export function validateManage(input: ManageInput, ctx: ManageContext): DecisionValidation;
export function validateReview(input: ReviewInput, ctx: ReviewContext): DecisionValidation;

/** Pure. Mirrors aiIdeaToRule (§5.13) exactly, with: id `persona-<skillHash.slice(0,8)>`, version 1,
 *  description idea.thesis, evidence [], symbols [idea.symbol], side idea.side, entryWhenAll [],
 *  invalidateWhenAny / stopAtrMultiple / targetRMultiple / maxHoldDays copied from the idea,
 *  forwardOnly true, origin "persona", and
 *  status = (cfg.channelStatus === "paper-passed" && cfg.passedSkillHash === skillHash) ? "paper-passed" : "experimental". */
export function personaIdeaToRule(idea: PersonaIdea, skillHash: string, cfg: PersonaConfig): RuleDefinition;

/** Pure. The rule used to re-plan a chosen report plan: the SOURCE rule's side, stopAtrMultiple,
 *  targetRMultiple, maxHoldDays and invalidateWhenAny, re-labelled as the persona channel — id
 *  `persona-<hash8>`, origin "persona", forwardOnly true, entryWhenAll [], evidence [],
 *  status as in personaIdeaToRule. Sizing inputs are therefore identical to the source plan's. */
export function reportPlanToPersonaRule(sourceRule: RuleDefinition, skillHash: string, cfg: PersonaConfig): RuleDefinition;

/** Pure. Attaches persona provenance to a plan produced by `planTrade`; changes no number and no
 *  other field. `planTrade` itself is NOT modified by revision 3 (P9). */
export function withPersonaProvenance(plan: Extract<TradePlan, { kind: "plan" }>, basedOnPlanId: string | null,
  basedOnRuleKey: string | null): Extract<TradePlan, { kind: "plan" }>;

/** I/O (reads files, no network). Fully specified below — the hash is a rule id and a gate identity, so
 *  two implementations must agree byte for byte. A missing or unreadable input throws `SkillHashError`;
 *  the CLI then exits 5 and writes nothing (fail closed: an unhashable skill cannot have a track record). */
export class SkillHashError extends Error {}
export function skillHash(opts?: { skillRoot?: string; promptPath?: string; repoRoot?: string }): string;

/** Pure. Builds the owner protocol from the sized plan and config. `nextReportAt` is the next
 *  `<date>T00:15:00Z` strictly after decidedAt; `timeExitOnOrBefore` is decidedAt + maxHoldDays × 24 h
 *  (a planning estimate: once the owner fills, the journal's `hoursToExpiry` is authoritative, §5.8a). */
export function buildOwnerProtocol(plan: Extract<TradePlan, { kind: "plan" }>, atr14d: number,
  cfg: PersonaConfig, decidedAt: number): OwnerProtocol;

/** Pure. Renders §5.6a's layout. Every dynamic string is escaped for Markdown table cells (`|` → `\|`);
 *  every absolute time is printed twice, `<UTC> UTC` and the same instant in `ownerProtocol.ownerTimeZone`. */
export function renderPlanReport(decision: DailyDecision, report: DailyReport): string;

/** I/O. Declared here for readability, but it LIVES IN `src/journal/manual-journal.ts` next to the
 *  journal it describes — `src/decision/` only reads it. Last exchange sync, as the journal server
 *  records it (see "Sync freshness" below). Missing file → null. Unparseable → throws (fail closed,
 *  never treated as "never synced"). */
export interface JournalSyncStatus { syncedAt: number; status: SyncResult["status"]; error: string | null; liveSync: "enabled" | "disabled"; }
export function readSyncStatus(opts?: { path?: string }): JournalSyncStatus | null;
export function writeSyncStatus(s: JournalSyncStatus, opts?: { path?: string }): void;   // called by the journal server only

export interface DecideArgs {
  date: string; mode: "plan" | "manage" | "review"; revise: boolean;
  trade: string | null;            // --trade <journal trade id>; REQUIRED for mode "manage" and "review", rejected for "plan"
  input: string | null;            // path; null = read stdin
  configPath: string;              // default "./config.json"
  decisionsRoot: string;           // default personaCfg.decisionsRoot
  reportsRoot: string;             // default "reports"
  journalPath: string;             // default "./manual-journal.json"
  rulesPath: string;               // default "./research-rules.json"
  aiRulesRoot: string;             // default "data/ai-rules"
  skillRoot: string;               // default personaCfg.skillRoot
  syncStatusPath: string;          // default "<journalPath minus .json>.sync.json", i.e. "./manual-journal.sync.json"
}
/** Injected so every test runs offline and deterministically (same shape as research:daily's deps). */
export interface DecideDeps {
  now(): number;
  readStdin(): Promise<string>;
  fetchKlines?: typeof fetchKlines;   // --mode review only, for reviewClosedTrade's 1h bars (§5.14)
}

/** I/O. The CLI body (§4.22). Resolves; never rejects for an expected failure — every expected failure
 *  is an exit code below. Writes nothing unless it returns exitCode 0. */
export function runDecide(args: DecideArgs, deps: DecideDeps):
  Promise<{ exitCode: number; message: string; decision: DailyDecision | ManageDecision | ReviewDecision | null; planReport: string | null }>;
```

#### `skillHash` — exact file set and algorithm (normative)

The hash is the persona channel's rule id **and** its Gate D1 identity, so it is specified to the byte;
two implementations that disagree would silently split or merge track records.

1. **File set** = every **regular file** under `<skillRoot>` (default `.claude/skills/crypto-fundamental-analyst/`),
   found **recursively**, **plus** `<promptPath>` (default `prompts/ai-analyst.md`). Not just `*.md`, and not
   just the `references/` and `assets/` directories that exist today: a new file of any extension, at any
   depth, is part of the skill and changes the hash.
2. **Excluded:** dotfiles and dot-directories (any path segment starting with `.`); anything that is not a
   regular file (directories, sockets, fifos); **symlinks are not followed** and not hashed (a symlinked
   instruction file would make the hash depend on state outside the repo). Nothing else is excluded — there
   is no ignore list and no glob library.
3. **Path form:** POSIX relative path from the repository root (`<repoRoot>`, default `process.cwd()`), forward
   slashes, no leading `./`.
4. **Order:** ascending **byte order** of that relative path string (not locale collation).
5. **Per-file digest:** SHA-256 of the file's **raw bytes** — no newline normalisation, no trimming, no
   text decoding, so a CRLF or a trailing-newline change is a change.
6. **Concatenation:** for each file in order, append the UTF-8 string `` `${relPath}\n${sha256Hex}\n` ``.
7. **Result:** SHA-256 of that concatenation, hex. First 8 chars are the rule id suffix (`persona-<hash8>`).
8. **Implementation:** `node:fs` only — `readdirSync(root, { recursive: true, withFileTypes: true })` plus
   `lstatSync` for the symlink check and `readFileSync` for the bytes. No `glob`, no new dependency (§10.1).
   A read error or a missing `<promptPath>` throws `SkillHashError` (exit 5, nothing written).

#### Validation (fail closed — mirrors §5.13 `verifyAiOutput`)

Any rejection ⇒ **exit 2**, nothing written, every rejection printed as `<code> <path>: <detail>`.
The table below is `--mode plan` (`validateDecision`); `--mode manage` and `--mode review` have their own
tables under "Manage and review modes".

| Check | Rejection |
|-------|-----------|
| Input is not JSON, or does not match `DailyDecisionInput` | `schema_invalid` |
| `input.dateUtc !== --date` | `date_mismatch` |
| `choice.kind === "report-plan"` and no plan in `report.plans` has that `planId` | `unknown_plan` |
| …the named plan exists but is `kind: "rejected"` | `not_a_plan` |
| …`now > thatPlan.expiresAt` | `expired` (the report's 12 h entry window, §5.5, has closed — re-run `research:daily` for a fresh report) |
| …the source rule can no longer be loaded, or its `ruleHash` differs from the plan's | `rule_changed` |
| `choice.kind === "persona-idea"`: a `{kind:"feature"}` ref whose symbol/feature is not `kind:"value"` in `ctx.features`, or whose `value` differs by more than `1e-9 × max(1, |value|)` | `unverifiable_feature` |
| …zero refs at all | `no_evidence` |
| …only `{kind:"web"}` refs (no verified feature ref) | `web_only_evidence` — the persona's searches are not captured by the system, so they can never be an idea's only evidence |
| …`idea.symbol ∉ configSymbols` | `symbol_not_configured` |
| …`confidence ∉ [0,1]`, `stopAtrMultiple ∉ (0,10]`, `targetRMultiple ∉ (0,20]`, `maxHoldDays ∉ 1..10` (integer), or an `invalidateWhenAny` condition that `parseRuleSet`'s condition validation would reject | `out_of_range` |
| `choice.kind === "no-trade"` with `reason.trim() === ""`; or `rationale.trim() === ""`; or a stance with zero non-empty reasons | `empty_reason` |
| A `kind:"plan"` plan in the report with no stance | `missing_stance` (path = that `planId`) |
| A stance whose `planId` is not a `kind:"plan"` plan of the report | `unknown_plan` |
| Two stances for the same `planId` | `duplicate_stance` |
| `planTrade` returns `kind:"rejected"` for the chosen/synthesized rule | `replan_rejected`, detail = the planner's reason — nothing is written, because there is nothing the owner could place; the persona re-runs with a `no-trade` choice or the owner clears the blocker |

Web refs never cause a rejection on their own: each is recorded in `validation.unverifiedWebRefs` and
rendered in Plan Report §6.

#### Sizing (P9 — the system sizes, always)

- **`persona-idea`** — `rule = personaIdeaToRule(idea, skillHash, personaCfg)`; synthesized outcome
  `{ ruleId: "persona-<hash8>", ruleHash: skillHash, symbol, result: "triggered", evidence: <feature refs as {feature: value}> }`;
  then `planTrade(outcome, rule, fv, plannerConfig, openTradeCount, breakerTripped, dateUtc,
  liveClosedTradesForPersona, ladderResetByBreaker, instruments[symbol] ?? null, report.decisionTime)`.
  `planId = <date>:persona-<hash8>:<symbol>` (planTrade's own format).
- **`report-plan`** — `rule = reportPlanToPersonaRule(sourceRule, skillHash, personaCfg)`, the same
  synthesized-outcome call with the same `decisionTime`, then
  `withPersonaProvenance(plan, chosenPlanId, "<sourceRule.id>@<sourceRuleHash.slice(0,8)>")`.
  Because every sizing input is identical, the planner reproduces the chosen plan's numbers exactly (AC-99);
  only `planId`, `ruleId`, `ruleHash`, `origin`, `basedOn*` and — once the two channels' `status` differ —
  `venueIntent`/`leverage` change.
- **Open-trade count** — `openTradeCount` = the number of `status:"open"` journal trades (both venues) **only**.
  The report's own plans are not counted: the persona *replaces* them with one decision rather than adding to
  them, and at most one decision per date is executed (§13 A31).
- **Breaker, instruments, decision time, `PlannerConfig`** — exactly the values `research:daily` used for that
  date's report, recomputed from the same sources. A tripped breaker therefore yields `replan_rejected`
  (`breaker_tripped`) and no decision, as it does for every other channel.
- **Never** does this module compute a size, a leverage, a venue, a stop or a target of its own.

#### Artifacts and write-once

| Path | Committed? | Rule |
|------|-----------|------|
| `data/decisions/<date>.json` | yes (§10.2) | write-once (`wx`, as `snapshot-store.ts`). Second run without `--revise` → exit 3 |
| `data/decisions/<date>.r<n>.json` | yes | written by `--revise`, `n` = 1, 2, 3…, never overwriting an existing revision; the **effective** decision for a date is the highest existing revision |
| `data/decisions/<date>.manage.<tradeId>.json` / `.manage.<tradeId>.r<n>.json` | yes | `--mode manage --trade <tradeId>`; write-once, `--revise` and "effective artifact" are scoped to the **(date, tradeId)** pair, so two positions managed on the same morning produce two independent records that never collide |
| `data/decisions/<date>.review.<tradeId>.json` / `.review.<tradeId>.r<n>.json` | yes | `--mode review --trade <tradeId>`, same per-(date, tradeId) rule |
| `reports/<date>.decision.md` | no — `reports/` is gitignored (§10.2) | derived; rewritten in full on each successful `--mode plan` run, so it always matches that date's newest decision revision. **Not** rewritten by `--mode manage` or `--mode review`: those artifacts are read directly, and the page's §7 lists the *paths* they will occupy rather than their contents |

**Identity, and what "already acted on" means.** A `--mode plan` artifact is identified by its **date**; a
`--mode manage` or `--mode review` artifact by the pair **(date, tradeId)**. Everywhere below, "the effective
artifact" means the highest existing revision *of that identity* — so a `--revise` of this morning's manage
decision for trade `A` can never touch, shadow or conflict with the one for trade `B` written the same morning.
`--revise` is refused (**exit 3**, nothing written, the offending id named) when the owner has already acted on
the artifact being revised:

- `--mode plan` — any journal trade's `planId` equals the effective decision's `plan.planId`.
- `--mode manage` — any journal event for that `tradeId` exists **after** the effective manage decision's
  `writtenAt`: a new exit fill, a changed `exitKind`, a `status` change to `closed`, or an `updatedAt` later
  than `writtenAt`. The instruction has been executed (or overtaken); its record is history, not a draft. The
  owner's route is a *new* manage decision tomorrow, not a rewritten one.
- `--mode review` — a review artifact is written after the trade is already closed, so its subject cannot move;
  `--revise` is allowed for it unless the trade is re-synced into a different `computed` review, in which case
  the mismatch is caught by the `out_of_range` check instead.

#### Manage and review modes

Both exist so the persona still never writes: it produces the block, the CLI validates and persists it. Both
require `--trade <id>`, and both refuse it on `--mode plan` (`schema_invalid`). The id must match the block's
own `tradeId` (`date_mismatch` otherwise, the same way `dateUtc` must match `--date`). The persona loops over
open positions by calling the CLI **once per trade**, never once per day: one position's `hold` and another's
`close now` are two artifacts, two exit codes and two records.

**`--mode manage --trade <id>`** (owner requirement 4e) — `validateManage(input, ctx)`:

| Check | Rejection |
|-------|-----------|
| Body is not JSON, or does not match `ManageInput`; or `--trade` is missing | `schema_invalid` |
| `input.dateUtc !== --date`, or `input.tradeId !== --trade` | `date_mismatch` |
| `ctx.trade === null` (no journal trade with that id) | `trade_not_found` |
| `ctx.trade.status !== "open"` | `trade_not_open` |
| `ctx.trade.plannedSnapshot === null` (unplanned fill — nothing to manage against) | `trade_not_planned` |
| **`input.thesis !== ctx.computedThesis`** | **`thesis_mismatch`**, detail `persona said <input>, system computed <computed>` |
| `action.kind === "tighten-stop"` and the price does not move the stop **toward** the entry while staying on the correct side of it — long: `plannedSnapshot.stopPrice < price < plannedSnapshot.referencePrice`; short mirrored | `out_of_range` (a "tightened" stop that widens risk, or crosses the entry, is refused) |
| `action.kind` is not exactly one of `hold` / `tighten-stop` / `close-now`, or `price` is not finite | `schema_invalid` |
| `reasons` has no non-empty entry | `empty_reason` |

`thesis_mismatch` is the same principle as the review mode's R check: **the persona reports the system's
state, it never asserts one.** `ctx.computedThesis` comes from `evaluateThesis(rule, fv)` on that day's
features, with the rule resolved exactly as §5.8a resolves a `planId` — `research-rules.json` for a
rule-origin trade, `data/ai-rules/<planId>.json` for an AI-origin one, the decision file's `personaRule` for
a persona-origin one — and is `not_evaluable` when the rule or a feature is unavailable. A persona that says
`intact` while the system computes `invalidated` has either misread the report or hallucinated the check;
either way the instruction built on it does not get recorded. The artifact stores `currentStopPrice` so the
owner's diff is explicit.

**`--mode review --trade <id>`** (owner requirement 4d) — `validateReview(input, ctx)`:

| Check | Rejection |
|-------|-----------|
| Body is not JSON, or does not match `ReviewInput`; or `--trade` is missing | `schema_invalid` |
| `input.dateUtc !== --date`, or `input.tradeId !== --trade` | `date_mismatch` |
| `ctx.trade === null` | `trade_not_found` |
| `ctx.trade.status !== "closed"` | `trade_not_closed` |
| `|input.rMultiple − ctx.computed.rMultiple| > 1e-6`, or `ctx.computed.rMultiple === null` while a number was supplied | `out_of_range` |
| `input.exitKind !== ctx.computed.exitKind`, or `input.followedPlan !== ctx.computed.followedPlan` (exact match, no tolerance) | `out_of_range` |
| `thesisVerdict` not one of `confirmed` / `invalidated` / `inconclusive` | `schema_invalid` |
| `lesson.trim() === ""` | `empty_reason` |

`ctx.computed` is `reviewClosedTrade(trade, klines1h)` (§5.9), reusing the journal server's cached review when
present. The persona supplies only what the system cannot compute: the thesis verdict and one lesson. The
artifact stores both the persona's `input` and the `computed` review, so a later disagreement is visible.

#### Sync freshness — `--revise` only

**Evidence.** The last-sync timestamp is `SyncResult.syncedAt` (`src/journal/exchange-sync.ts:263`), but it
lives **only in the journal server's process memory** (`src/server/journal-server.ts:150`, `:175`) and is served
at `GET /api/state` as `lastSync` (`:296`); `manual-journal.json` itself stores no sync time — `ManualTrade.updatedAt`
is the only persisted timestamp. A separate CLI therefore cannot currently know how fresh the journal is.

Phase 6 closes that gap with a **sidecar**, not a network call: the journal server calls `writeSyncStatus`
after every sync attempt (the `lastSync = result` path, `src/server/journal-server.ts:175`, plus the paper-only
branch at `:164`), writing `manual-journal.sync.json` — gitignored, next to the journal, holding
`{ syncedAt, status, error, liveSync }`. `decide` reads it with `readSyncStatus`.

Because "already acted on" is judged from the journal, a stale journal makes that judgement worthless: a fill
that already happened may simply not be imported yet. So **before** evaluating the "already acted on" rules
above, `--revise` in modes `plan` and `manage` requires:

- a readable `manual-journal.sync.json` (missing → **exit 5**; unparseable → **exit 5**, never treated as fresh), **and**
- either `liveSync === "disabled"` (paper-only mode, §5.8a — there is no exchange state to be stale about, so the
  check passes and the decision records that it was skipped), **or** `status === "ok"` **and**
  `now − syncedAt <= manual.staleAfterMs` (§5.11, default 120 000).

Otherwise: **exit 5**, message `journal_stale: run the journal server sync first`, nothing written. The owner's
fix is to start or leave `npm run journal` running — it syncs on startup and every `manual.syncIntervalMs`
(§5.11, default 30 000; `src/server/journal-server.ts:488-490`) — and confirm `GET /api/state` shows
`lastSync.status: "ok"`. A first run (no `--revise`) is not gated: it writes a new record rather than
overwriting a judgement about what the owner has already done.

#### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Decision written; the written artifact's path (and, for `--mode plan`, the Plan Report path) is printed on stdout |
| 2 | Validation failed (any row of the rejection table), including a missing/ill-placed `--trade` or one naming a trade in the wrong state. Nothing written; every rejection printed |
| 3 | Precondition: no `reports/<date>.json` (message contains `run research:daily first`); or an artifact **of that identity** — `<date>` for `plan`, `(<date>, <tradeId>)` for `manage`/`review` — exists and `--revise` was not given; or `--revise` was given but the owner has already acted on that artifact (rules above) |
| 4 | `--date` unparseable, or its `00:15:00Z` decision time is in the future |
| 5 | `manual-journal.json` unreadable (all backups corrupt, `JournalUnreadableError`), `research-rules.json` unreadable/invalid, `skillHash` cannot be computed (`SkillHashError`), or — on `--revise` in modes `plan`/`manage` — the journal's last sync is missing, unparseable, failed, or older than `manual.staleAfterMs` (`journal_stale: run the journal server sync first`) |

Codes 0/2/3/4/5 mirror `research:daily`'s meanings exactly, so the two CLIs read the same way.

#### Persona skill changes — §4.23 (normative)

`.claude/skills/crypto-fundamental-analyst/` gains three **Decision Gates** rows and one reference file. Its
existing Hard Rules, Output Contract and disclaimer stay as they are; AC-39's amendment (§6.7) governs (a) and (c).

| New gate | The persona does | It never does |
|----------|------------------|---------------|
| `decide today's plan` | Read today's report; run the staleness, theory and news protocols; give a stance on **every** `kind:"plan"` plan; then emit one fenced ```json``` block matching `DailyDecisionInput` and offer to run `npm run decide -- --date <date>`; on a non-zero exit, show the CLI's rejections verbatim and emit a corrected block | Write any file; state a size, leverage, venue, quantity, stop or target of its own; claim the decision is recorded before the CLI exits 0 |
| `manage open position` | For **each** open journal trade, **one at a time**: re-check `invalidateWhenAny` via the day's report, the news protocol and `openTradeThesis`; copy that trade's `openTradeThesis.state` into the block's `thesis` field **verbatim** (the CLI recomputes it and rejects a mismatch, `thesis_mismatch`); output **exactly one** of `hold` / `tighten stop to <price>` / `close now` with reasons, as a `ManageInput` block naming that `tradeId`, then run `npm run decide -- --mode manage --date <date> --trade <tradeId>`. Two open positions ⇒ two blocks and two commands, never one combined block | Suggest adding to, averaging into, or re-entering a position; propose a stop that widens risk or crosses the entry; batch several trades into one block or one artifact; act on it itself |
| `review closed trade` | Per closed trade: read the journal's computed review (`GET /api/review/:tradeId`), restate its `rMultiple`, `exitKind` and `followedPlan` unchanged, add the thesis verdict and one lesson, emit a `ReviewInput` block and run `npm run decide -- --mode review --date <date> --trade <tradeId>` | Compute or adjust R, re-classify the exit, grade adherence itself, or review several trades in one block |

Three hard rules are added to the skill. What actually checks each one — stated per rule, because "the tests
cover it" is the kind of claim that quietly stops being true:

1. **`npm run decide` is the only writer.** The persona never creates, edits or deletes a file — not
   `data/decisions/`, not `reports/`, not `research-rules.json`, not `config.json`. Its output is a JSON block plus,
   at most, that one command. *Checked by:* the existing AC-39 (a)/(c) mechanical assertions in
   `tests/persona-skill.test.ts` (the skill text must still forbid writing and must still forbid stating
   size/leverage/venue), plus the **[manual]** AC-116 for the behaviour. A text assertion cannot prove a model
   will not write a file; AC-116 and verification gate 15 are what actually cover that.
2. **The block must carry a stance for every plan.** A `DailyDecisionInput` whose `stances` miss any `kind:"plan"`
   plan of that date's report is invalid and the CLI will reject it — the persona states its opinion of the plans
   it *didn't* pick, every day, so the record can be read back against outcomes. *Checked by:* **AC-104**
   (`missing_stance`), in the CLI — the enforcement is the validator, not the prose.
3. **Editing this skill restarts Gate D1 at zero.** `SKILL.md` must carry that sentence verbatim —
   `Editing this skill restarts the persona channel's Gate D1 at zero.` — because the reader of the skill is the
   one about to edit it. Every file under the skill directory, plus `prompts/ai-analyst.md`, is hashed into
   `skillHash` (§5.15), which is the persona channel's rule id and `ruleHash`; changing any of them starts a new
   60-trade / 45-day count (§8.5). *Checked by:* **AC-121**
   (the literal sentence is present in `SKILL.md`) and **AC-110** (the hash actually changes when any of those
   files changes).

`references/decision-protocol.md` (new) holds the `DailyDecisionInput` / `ManageInput` / `ReviewInput` shapes, the
§5.15 rejection table in the persona's own words, the exact `npm run decide` invocations **including the mandatory
`--trade <id>` on manage and review and the one-call-per-trade rule**, and the owner-protocol vocabulary (execute
window, gap rule, the two come-back cases) so the persona's chat answers and the Plan Report say the same thing.

---

### 5.16 Phase 7 hardening

Three independent, P2, additive items. None changes a shipped number, a gate, or any existing rule's
`forwardOnly`. §9's Phase 7 row names them; this section is their contract.

#### Item 1 — Coinalyze OI (`coinalyze-oi`)

`coinalyze-oi` is already a valid `SourceId` (§5.1) with a declared `maxStalenessMs` of 26 h
(`src/research/features.ts`'s `DEFAULT_STALENESS_MS`, unchanged) but no adapter before this phase. It exists to
give `oiChange3dPct` real point-in-time OI history: `bybit-oi`'s own history is only 10 daily points
(§10.3), too short for a stable D0 backtest window, while Coinalyze's `interval=daily` granularity is
**never deleted** (its docs: "For daily timeframe/granularity we do not delete the old data" — only
intraday granularities age out after ~1500–2000 points).

```ts
// src/research/sources/coinalyze-oi.ts
export const COINALYZE_BYBIT_EXCHANGE_CODE = "6"; // Coinalyze's exchange code for Bybit — verified
  // 2026-09-16 by loading https://coinalyze.net/markets/?exchange=6 and confirming the page renders
  // as "Bybit Live Prices and Charts" (Coinalyze's own market browser keys off this exact code;
  // the API gives no unauthenticated way to list exchange codes, since /exchanges requires a key).

export function coinalyzeSymbolFor(appSymbol: string): string;
  // "BTC/USDT" -> "BTCUSDT.6" (appSymbolToBybit's base+quote + "." + Coinalyze's exchange code;
  // verified live against GET /v1/future-markets, 2026-09-17: Bybit USDT perps carry no infix).
  // There is no cross-exchange "aggregated" symbol in Coinalyze's contract; every symbol names one
  // exchange, so this always names Bybit specifically, matching what bybit-oi.ts itself measures.

export function buildCoinalyzeSymbolMap(symbols: readonly string[]): Map<string, string>;
  // coinalyze symbol -> app symbol, for the reverse lookup a parsed response needs. Shared between
  // the live adapter and scripts/backfill-history.ts so both build the exact same request.

export function parseOiHistoryResponse(
  parsed: unknown,
  appSymbolByCoinalyze: ReadonlyMap<string, string>,
): { kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string };
  // Pure parser reused verbatim by the live adapter and the backfill script (the file-header
  // convention every other backfilled source already follows). One input row per returned daily
  // candle: `{ key: appSymbol, observedFor: candle.t * 1000, availableAt: observedFor + 25h,
  // field: "oi", value: candle.c }` — `c` (the candle's closing OI, Coinalyze's
  // `candlestick_oi` shape: `{t,o,h,l,c}`) is used as the day's OI reading, the same role
  // `bybit-oi.ts`'s single point-in-time `openInterest` value plays for `computeOiChange3dPct`
  // (which only ever reads one `value` per row, sorted by `observedFor`). `observedFor` is the
  // candle's own start (UTC day boundary, matching every other daily row in this system, e.g.
  // `bybit-klines-1d`'s bar-open convention). `+ 25h` is documented below.

export function createCoinalyzeOiAdapter(deps: AdapterDeps): SourceAdapter;
  // id "coinalyze-oi", maxStalenessMs 26h (DEFAULT_STALENESS_MS, unchanged). fetch() reads
  // `COINALYZE_API_KEY` from the environment only — never from config.json (same rule as every
  // other credential in this system, §10.2) — and returns `unavailable` with detail
  // "COINALYZE_API_KEY not set" when it is absent, never throwing. When set, it requests the last
  // 10 daily candles per symbol (matching bybit-oi.ts's own `limit=10`, comfortably above
  // oiChange3dPct's 4-row minimum) in ONE HTTP call for all of `symbols` (Coinalyze's `symbols`
  // param is comma-separated, up to 20):
  //   GET https://api.coinalyze.net/v1/open-interest-history
  //     ?symbols=<coinalyze symbols, comma-separated>&interval=daily
  //     &from=<decisionTime/1000 - 10*86400>&to=<decisionTime/1000>&api_key=<COINALYZE_API_KEY>
  // The key travels as the `api_key` query parameter (Coinalyze's own documented auth: header OR
  // query param, both named `api_key`) — it matches http.ts's existing `SECRET_QUERY_PARAM` regex
  // (`api[_-]?key`), so `redactUrl`/the network-error path already redact it with no adapter-side
  // change, the same as FRED's `api_key`. A non-2xx/network failure or unparseable body ->
  // `unavailable` via `fetchWithRetryPolicy` (§7/AC-7a: 10s timeout, one 429 retry ≤ 60s). An
  // array whose shape doesn't match (§10.2's declared contract) -> `invalid`, zero rows.
```

**Rate limiting.** Coinalyze's free tier is 40 API calls per minute per key (§10.2), and Coinalyze's own
accounting charges **one credit per symbol named in `symbols`**, even though the whole request is a
single HTTP round trip — so a 2-symbol (BTC+ETH) request costs 2 of the 40. `src/bybit/rate-limiter.ts`'s
`EndpointRateLimiter` is Bybit-specific (keyed off `src/bybit/types.ts`'s per-path budgets) and is not
reused; instead:

```ts
// src/research/sources/coinalyze-shared.ts
export interface CoinalyzeRateLimiterDeps { now: () => number; sleep: (ms: number) => Promise<void>; }
export interface CoinalyzeRateLimiter { acquire(): Promise<void>; }
export function createCoinalyzeRateLimiter(options?: {
  capacity?: number; refillPerMinute?: number; deps?: CoinalyzeRateLimiterDeps;
}): CoinalyzeRateLimiter;
  // Token bucket; capacity/refillPerMinute default to the documented 40/min budget. `deps`
  // defaults to the real clock/timer — overridable so tests never sleep in real time.
export function acquireCoinalyzeSlot(): Promise<void>;
  // One module-level shared instance (capacity 40, refill 40/min) — same "one shared bucket per
  // process" pattern as bybit-shared.ts's acquireBybitSlot. The live adapter and the backfill
  // script both `await acquireCoinalyzeSlot()` once per symbol in the request, before the single
  // `fetch` call, so the credit accounting matches Coinalyze's, not the HTTP call count.
```

**Feature wiring — precedence (`src/research/features.ts`).** `oiChange3dPct` keeps `bybit-oi` as the
primary source and falls back to `coinalyze-oi` only when `bybit-oi` cannot produce a value:

1. If `bybit-oi`'s snapshot resolves (`status: "ok"`, not stale) **and** `computeOiChange3dPct` over its
   rows succeeds (≥ 4 observations, ≤ 24 h gap to the target `latest − 3d` row), that value is used —
   `FeatureValue.sourceId: "bybit-oi"`. `coinalyze-oi` is not even inspected in this case.
2. Otherwise, if `coinalyze-oi`'s snapshot resolves **and** `computeOiChange3dPct` over *its* rows
   succeeds, that value is used instead — `FeatureValue.sourceId: "coinalyze-oi"`. This is the "sourceId
   recorded on the FeatureValue is the one actually used" rule from §9's Phase 7 row.
3. Otherwise the feature is `{kind:"missing"}` with `sourceId: "bybit-oi"` (the nominal primary,
   matching `FEATURE_SOURCE_ID.oiChange3dPct`, which is **not** changed by this section) and the reason
   is `bybit-oi`'s own failure reason — never a compound message blending both sources' failures.

`FEATURE_SOURCE_ID.oiChange3dPct` stays `"bybit-oi"`: it names the nominal/primary source for
Gate D1's `unexplainedIncompleteDays` bookkeeping (§5.10a), which is out of scope for this section. A day
on which `oiChange3dPct` was actually populated via the `coinalyze-oi` fallback still counts as
"sourced from bybit-oi" for that bookkeeping — an accepted approximation (the feature genuinely had a
value that day), not a defect, and not something this section's tests assert against.

**Backfill (`scripts/backfill-history.ts`).** A new `coinalyze-oi` history source is added to
`runBackfill`, built with the exact same `parseOiHistoryResponse` the live adapter uses (this file's
existing convention: "only `availableAt` differs" — here it doesn't even differ, since Coinalyze's
`from`/`to` window already returns genuine historical daily candles, unlike sources whose live
`availableAt` is a conservative `fetchedAt` stand-in). One request covers the whole `[--from, --to]`
window (daily granularity is never deleted, so no paging is needed). Missing `COINALYZE_API_KEY` records
`{ sourceId: "coinalyze-oi", rows: [], failure: "COINALYZE_API_KEY not set" }` — same non-fatal-to-the-run
contract as every other backfilled source. `bybit-oi` itself is still **not** backfilled (its own history
is too short to be worth requesting, unchanged) — `coinalyze-oi` is the new, separate, deeper-history
source `oiChange3dPct` can fall back to once its history is backfilled.

**Declared availability lag (extends §10.3).** A daily OI candle's own close is `observedFor + 24h`
(the candle covers one UTC day); Coinalyze's docs don't publish a settlement/processing lag for the
daily granularity the way FRED or DefiLlama do for theirs, so this reuses the existing "+1h cushion"
convention already used for `fear-greed` (§10.3: "D at 00:00 UTC + 1h") rather than inventing a new
unverified number: **`availableAt = observedFor + 24h + 1h`** (25h total), for both the live adapter and
the backfill. Once a rule's D0 window is covered by a `coinalyze-oi` backfill run (`npm run backfill
--from <date> --to <yesterday>`, same command as every other source), that rule no longer *needs*
`forwardOnly: true` on account of `oiChange3dPct` — stated here as a capability, not a retroactive
edit: no existing rule's `forwardOnly` flag is changed by this section (none of the 3 shipped example
rules reference `oiChange3dPct`).

**Docs (`docs/DAILY_WORKFLOW.md`).** `COINALYZE_API_KEY` (free key from coinalyze.net) is added next to
`FRED_API_KEY` in the secrets-file section, with a one-line note on what it adds (deeper OI history for
`oiChange3dPct`, and D0 backtests that no longer need `forwardOnly` for it) and the backfill command.

#### Item 2 — Desktop notification when a report is written

```ts
// src/config.ts — ManualTradingConfig gains:
notifyOnReport: boolean; // default false. Best-effort desktop notification once research:daily
  // finishes writing a report (rules-only or, when the AI step ran, the final report).
```

```ts
// scripts/research-daily.ts
export interface ResearchDailyArgs {
  // ...existing fields...
  notify: boolean; // --notify flag; ORed with manual.notifyOnReport (either one turns it on for this run)
}
export type NotifySpawnFn = (
  command: string, args: readonly string[],
) => { on(event: "error", listener: (err: Error) => void): void };
export async function runResearchDaily(
  args: ResearchDailyArgs,
  deps: AdapterDeps,
  aiClientFactory?: (cfg: AiAnalystConfig, snapshotRoot: string) => AiClientPort,
  spawnFn?: NotifySpawnFn, // defaults to node:child_process's real `spawn`
): Promise<ResearchDailyResult>;
```

After the report is written — the rules-only report when the AI step doesn't run (`aiDisabledReason !==
null`), otherwise the final report after `attachAiAnalyst` — and only when `manual.notifyOnReport ||
args.notify`, `runResearchDaily` calls
`spawnFn("notify-send", ["crypto-trader", "<date> report written: <n> rule plans, <m> AI plans, ai
<status>"], { stdio: "ignore" })`, where `<n>`/`<m>` count that report's `plans` entries with
`kind:"plan"` and `origin:"rules-file"`/`"ai-analyst"` respectively, and `<status>` is
`report.aiAnalyst.status`. This is **best-effort and fire-and-forget**: it never `await`s the child, it
attaches only an `"error"` listener (fired for a missing `notify-send` binary — `ENOENT` — or any other
spawn failure), and both that listener and a synchronous `spawnFn` throw are caught and print one
`console.error` line; neither ever changes `runResearchDaily`'s return value, exit code, or the report
files already written on disk. A run with notification disabled never calls `spawnFn` at all.

#### Item 3 — CSV export of reviews

```ts
// src/journal/trade-analytics.ts
export function reviewsToCsv(rows: readonly { trade: ManualTrade; review: ClosedTradeReview }[]): string;
```

One row per entry, columns in this fixed order: `tradeId, symbol, side, planId, ruleId, origin,
aiStanceAtPlan, entryTime, exitTime, entryPrice, exitPrice, quantity, rMultiple, netPnlUsd, fundingUsd,
feesUsd, exitKind, followedPlan, entrySlippagePct, sizeDeviationPct, maePct, mfePct, notes` — the first 7
and `notes` come from the trade itself (`entryTime`/`exitTime` are the earliest entry / latest exit fill
time, ISO-8601 UTC; `entryPrice`/`exitPrice` are the fill-quantity-weighted average price of the entry /
exit fills; `quantity` is the summed entry fill quantity), the rest verbatim from that trade's
`reviewClosedTrade` result (§5.9). `null` fields render as an empty CSV field. Quoting is RFC 4180: a
field containing a comma, double quote or newline is wrapped in double quotes with every internal double
quote doubled — `notes` is free text and is the field most likely to need it. The header row is always
present, even with zero data rows; every line (header included) ends `\r\n`.

```ts
// src/server/journal-server.ts — new endpoint
// GET /api/reviews.csv
```

One row per **closed** journal trade (the same set `/api/stats?venue=` reviews, both venues combined
here — this is a raw export, not a venue-filtered statistic), reusing the same per-trade `reviewOne`
cache the existing `/api/review/:tradeId` and `/api/stats` handlers already use (no repeated kline
fetches). Response: `Content-Type: text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="reviews-<date>.csv"` where `<date>` is today's UTC date
(`deps.now()`, `YYYY-MM-DD`) — not any one trade's date, since the export always covers the whole
journal. Subject to the same Host-header check as every other endpoint (the existing global
middleware); GET needs no Origin check, same as every other `GET`. An empty journal (or one with no
closed trades) returns 200 with the header row only.

```html
<!-- public/journal.html — "Closed trades — review" heading gains a plain link -->
<a href="/api/reviews.csv">Export CSV</a>
```

---

## 6. Acceptance criteria

Each item maps to at least one test in `tests/` (root level, per E11) unless marked **[manual]**.

### 6.1 Data & point-in-time (P0)
- [ ] AC-1: Given a snapshot row with `availableAt = T+1`, when `buildFeatures` runs at `decisionTime = T`, then the dependent feature is `{kind:"missing"}`.
- [ ] AC-1b: Given a scheduled time of 00:15 and fetches completing at +3 s, +9 s and +41 s, then the effective decision time is 00:15:41 (`live`) and a fear-greed row with `availableAt` = its `fetchedAt` is a `value`; given any fetch more than 2 h after 00:15, then the decision time is 00:15:00 (`scheduled`).
- [ ] AC-2: Given a source snapshot with `status:"unavailable"`, when `buildFeatures` runs, then every feature fed by that source is `missing` with a `reason` containing the `statusDetail`.
- [ ] AC-3: Given a snapshot `fetchedAt` older than its `maxStalenessMs`, when `buildFeatures` runs, then its features are `missing` with reason `"stale"`.
- [ ] AC-4: Given `data/snapshots/2026-09-16/fear-greed.json` exists, when `writeSnapshot` is called for the same date/source without `revision`, then it throws `SnapshotExistsError` and the file bytes are unchanged.
- [ ] AC-5: Given a snapshot file edited on disk, when `readSnapshots` reads it, then it throws (SHA mismatch).
- [ ] AC-6: Given a recorded Farside HTML fixture with a changed column header, when the adapter parses it, then it returns `status:"invalid"` and zero rows (never partial rows).
- [ ] AC-7: Given a network error, when any adapter's `fetch` is called, then the promise resolves (does not reject) with `status:"unavailable"`.

### 6.2 Rules & planner (P0)
- [ ] AC-8: Given a rule set with 3 distinct errors, when `parseRuleSet` runs, then `RuleSetValidationError.issues.length === 3`.
- [ ] AC-9: Given a rule whose first condition fails and whose second references a missing feature, when `evaluateRule` runs, then `result === "not_evaluable"`.
- [ ] AC-10: Given any change to a rule's fields, when `ruleHash` is computed, then it differs; given key reordering only, then it is identical.
- [ ] AC-11: Given `maxCapitalUsd=100, riskPerTradePercent=1, atr14d=1000, stopAtrMultiple=2, referencePrice=60000, marginBudgetPercent=25, maxLeverage=5, liveLadderCap=2, rule.status="paper-passed", liveClosedTradesForRule=0, ladderResetByBreaker=false, instrument={minOrderQty:0.0001, qtyStep:0.0001, minNotionalValue:5}`, when `planTrade` runs, then `riskUsd=1, quantity=0.0005, notionalUsd=30, leverage=2, marginUsd=15, stopPrice=58000, targetPrice=` 60000 + 2000 × targetRMultiple (±1e-9).
- [ ] AC-11a: Given the AC-11 inputs with `qtyStep=0.001, minOrderQty=0.001`, then `rejected: size_below_min`; given `qtyStep=0.0003, minOrderQty=0.0003`, then `quantity=0.0003`, `riskUsd=0.6`, `notionalUsd=18`, `marginUsd=9`.
- [ ] AC-11b: Given `instrument=null`, then `rejected: instrument_missing`; given `atr14d` or `close` missing, then `rejected: atr_missing`.
- [ ] AC-12: Given the same inputs with `rule.status="holdout-passed"`, then `leverage=1` and `venueIntent="paper"`.
- [ ] AC-13: Given inputs where every leverage from `maxLeverage` down to 1 yields `liqToStopRatio < minLiqToStopRatio`, then `kind:"rejected", reason:"liq_too_close"`.
- [ ] AC-14: Given `breakerTripped=true`, then every plan is `rejected: breaker_tripped`; given `openTradeCount >= maxOpenManualTrades`, then `rejected: max_open_trades`.
- [ ] AC-15: `estimateLiquidationPrice(100,"long",2,0.005) === 50.5` and `estimateLiquidationPrice(100,"short",2,0.005) === 149.5` (±1e-9).
- [ ] AC-14a: Given `maxOpenManualTrades = 3`, 1 open journal trade, and 4 rules that all trigger, when `research:daily`'s planning step runs, then the report has exactly 2 `kind:"plan"` and 2 `rejected: max_open_trades` (the last two in rule order); given additionally 1 verified AI idea, then that idea yields `rejected: max_open_trades`.
- [ ] AC-7a: Given a source adapter whose fake HTTP layer returns 429 with `Retry-After: 1` twice, then exactly 2 requests are made and the snapshot is `unavailable`; given 429 then 200, then the snapshot is `ok`; given `Retry-After: 120`, then no retry is made and the snapshot is `unavailable` (cap 60 s).
- [ ] AC-15a: Given `maxLeverage=5, liveLadderCap=2`, then `effectiveMaxLeverage` returns 1 for status `holdout-passed`; 2 for `paper-passed` with 19 live trades; 5 with 20 live trades; 2 with 20 live trades and `ladderResetByBreaker=true`.

### 6.3 Report (P0)
- [ ] AC-16: Given any source not `ok`, when `buildReport` runs, then `completeness === "incomplete"` and the first line of `renderReportMarkdown` starts with `INCOMPLETE`.
- [ ] AC-17: Given any report, then `disclaimer` equals the literal in §5.6 and the Markdown contains it.
- [ ] AC-18: Given `research:daily` run twice for the same date without `--refetch`, then the second exits with code 3 and the report file is unchanged.
- [ ] AC-19: Given an open trade whose rule's `invalidateWhenAny` condition is met, then `openTradeThesis[i].state === "invalidated"`.

### 6.4 Backtest & Gate D0 (P0)
- [ ] AC-20: Given a 1h bar whose low ≤ stop and high ≥ target, when `simulatePlan` runs, then `exitKind === "stop"`.
- [ ] AC-21: Given a long held across 2 funding settlements at +0.01% on $30 notional, then `fundingUsd === -0.006`.
- [ ] AC-22: Given `--mode dev` and any sim trade with `entryTime >= holdoutStart`, then the script exits non-zero before writing any artifact.
- [ ] AC-23: Given a ledger with 3 prior entries for `ruleId`, then the CLI still appends a 4th ledger line before simulating and the verdict is `holdout_exhausted` (`ruleEvaluationIndex 4`).
- [ ] AC-24: Given 29 trades all at +1R, then verdict `insufficient_data`.
- [ ] AC-25: Given identical inputs and `seed`, then two `runGateD0` calls return deep-equal reports except `generatedAt`.
- [ ] AC-26: Given 40 trades with meanR > 0 but bootstrap lower bound ≤ 0, then `no_edge` with `verdictReason` starting `step 4`.
- [ ] AC-76: `mulberry32(1)` produces a fixed first-three-values sequence recorded in the test; two generators with the same seed produce identical 1 000-value sequences.
- [ ] AC-77: `snapshotsAt` at T excludes a row with `availableAt = T + 1`; a fear-greed history whose last row ≤ T is 3 days old yields `fetchedAt` 3 days before T, so `buildFeatures` marks `fearGreed` missing (`stale`) with the 26 h staleness.
- [ ] AC-78: Farside history row for US trading day 2025-03-03 has `availableAt = 2025-03-04T12:00Z`; at decision time 2025-03-04T00:15Z it is not visible, at 2025-03-05T00:15Z it is.
- [ ] AC-79: Simulation, long plan (stop 95, target 110, qty 1, slippage 0): bar 1 opens 94 → `stop` exit at 94 (gap-through, worse than the stop); bar with o 100 h 111 l 99 → `target` at 110; o 112 on a later bar → `target` at 110, never 112.
- [ ] AC-80: With `slippageBps 5`, a long entry at bar open 100 fills at 100.05 and a stop exit at 95 fills at 94.9525.
- [ ] AC-81: A 1h series with one missing bar between entry and the exit bar → `unfilled` with reason containing `gap`; a needed bar beyond `cutoffMs` → `unfilled` with reason containing `cutoff`.
- [ ] AC-82: Funding rows at the actual `fundingRateTimestamp` values (e.g. every 4 h) are all applied, including one not on 00/08/16 UTC; a row exactly at `entryTime` is not applied; a row exactly at `exitTime` is.
- [ ] AC-83: `replayRule` with a rule that triggers on 3 consecutive days for one symbol while the first sim trade is held 5 days produces 1 trade and 2 unfilled `position already open`.
- [ ] AC-84: Dev mode never reads a 1h bar with `t + 1h > holdoutStart`: a fake history whose bars at or after holdoutStart throw on access completes the dev run.
- [ ] AC-85: Bootstrap on R = [1, 1, 1, 1] gives CI90 [1, 1]; permutation p uses `(1 + k)/(1 + runs)`: 0 of 999 exceeding → p = 0.001; with 899 completed runs → `insufficient_data` (step 2b).
- [ ] AC-86: Holdout mode for a `forwardOnly` rule or an `ai-analyst-*` id exits 1 and appends no ledger line; for an eligible rule the ledger line exists even if simulation then throws.
- [ ] AC-91: Day-clustered bootstrap is wider than per-trade: 40 trades on 10 days where every day's 4 trades share that day's R, with day R values [−1, 2, −1, 2, −1, 2, −1, 2, −1, 2], produce a CI90 width strictly greater than a per-trade i.i.d. bootstrap of the same 40 values with the same seed (the test computes both).
- [ ] AC-92: Global alpha: a ledger with 2 entries for rule `a` and 1 for rule `b` (same window) gives rule `c`'s first run `ruleEvaluationIndex 1`, `globalEvaluationIndex 4`, `alpha 0.025`.
- [ ] AC-93: Holdout mode refuses (exit 1, ledger unchanged) when `research-rules.json` has uncommitted changes, when the ledger has an entry with a different `holdoutStart`, and when the ledger has an unparseable line.
- [ ] AC-94: Permutation preserves exposure: for observed clusters `[{A}, {A}, {A, B}]`, every permutation run simulates exactly 4 trades — A three times and B once — and the `{A, B}` cluster's day is eligible for both symbols.
- [ ] AC-95: Contiguity: 15 daily bars with one missing day inside the last 15 → `atr14d` missing with reason `gap in daily bars`; the same with no gap → value. A stablecoin comparison row 30 h older than its target → `stablecoinSupplyChange7dPct` missing (`gap`). 5 ETF rows spanning 10 calendar days → `btcEtfNetFlowUsd5d` missing.
- [ ] AC-96: `insufficient_data` when `decisionDaysWithTrades < 20` even with 40 closed trades.
- [ ] AC-97: Permutation draws only fillable days: with 100 eligible days of which 90 are `size_below_min` for the symbol and 10 fill, 1 000 runs all complete and every drawn day is one of the 10; with 0 fillable days, 0 runs complete (→ `insufficient_data`, step 2b). A 2-symbol cluster only draws days fillable for both symbols.
- [ ] AC-87: `topSymbolShare` for per-symbol P&L {A: +8, B: +2, C: −20} is 0.8.
- [ ] AC-88: d1-check ignores paper trades whose `ruleHash` differs from the current rule, and ignores a gate-d0 artifact with `edge_confirmed` but a different `ruleHash` (→ D1 `failed`, step 1).
- [ ] AC-89: `unexplainedIncompleteDays`: 5 days since first paper entry, 2 reports incomplete on a source the rule uses, 1 report missing, 1 of those 3 dates listed in `docs/validation/d1-<ruleId>.md` → 2.
- [ ] AC-90: The gate-d0 artifact contains `holdoutTradeR` with length `closedTrades`, `holdoutTradeDays` aligned with it, `symbols` with first kline times, `slippageBps`, `seed`, `permutationRunsCompleted`, and `historyCoverage` for every source.

### 6.4a Gate D1 (P0)
- [ ] AC-26a: Given 30 paper reviews over 46 days with expectancyR 0.30, adherenceRate 0.93, `d0Block30P10 = 0.05`, `unexplainedIncompleteDays = 0`, then verdict `paper_passed`.
- [ ] AC-26b: Given the same with 29 reviews, or with 44 calendar days, then `not_yet` (`step 2`).
- [ ] AC-26c: Given the AC-26a inputs with adherenceRate 0.85, then `failed` (`step 5`) regardless of expectancy.
- [ ] AC-26d: Given the AC-26a inputs with expectancyR 0.02 < `d0Block30P10` 0.05, then `failed` (`step 4`).
- [ ] AC-26e: Given `forwardOnly=true` and 45 paper reviews, then `not_yet`; with 60 reviews and the other AC-26a values, then `paper_passed` and `d0Block30P10 === null`.
- [ ] AC-26f: Given any review with venue `bybit-live` or another `ruleId`, then `runGateD1` throws.
- [ ] AC-26g: Given `forwardOnly=false` and `d0Holdout=null`, then `failed` (`step 1`).

### 6.5 Journal, sync, analytics (P0)
- [ ] AC-27: Given a key whose `/v5/user/query-api` response has `readOnly: 0`, when the journal server starts, then it throws `TradePermissionKeyError` and does not bind the port.
- [ ] AC-28: Given the same execution returned by two syncs, then the journal contains it once.
- [ ] AC-29: Given a sync network failure, then `SyncResult.status === "failed"`, existing trades are unchanged, and `liveView(...).stale === true` once `now - lastSyncAt > staleAfterMs`, with `markPrice`, `unrealisedPnlUsd` set to `null`.
- [ ] AC-30: Given an exchange position with no linkable plan, then its `ManualTrade.planId === null` and `liveView.alerts` includes `"unplanned"`.
- [ ] AC-31: Given `exchangeLiqPrice` closer to entry than `plannedSnapshot.stopPrice`, then `alerts` includes `"stop_beyond_liquidation"`.
- [ ] AC-32: Given actual size differing from plan by > 10%, then `alerts` includes `"size_deviates_from_plan"`; given `actualLeverage > plannedSnapshot.leverage`, then `"leverage_exceeds_plan"`.
- [ ] AC-33: Given a closed planned trade with netPnl −$1.10 and plannedRisk $1.00, then `rMultiple === -1.1`.
- [ ] AC-34: Given `aggregate` over reviews of venue `paper`, then no `bybit-live` review contributes (venues never blend).
- [ ] AC-35: Given a corrupted `manual-journal.json` and a valid `.bak.1`, then `loadManualJournal` returns `.bak.1` contents; given all 6 corrupt, then it throws `JournalUnreadableError` and the server refuses to start.
- [ ] AC-36: Given the journal server, when started, then it listens on `127.0.0.1:journalPort` and not `0.0.0.0` (assert on `server.address()`).

### 6.5a Journal reconstruction & wiring (P0)
- [ ] AC-55: Given executions buy 1 @100, buy 1 @110, sell 2 @120 (BTC/USDT, after journalStartTime), then one closed trade with 2 entry fills, 1 exit fill, avgEntry 105.
- [ ] AC-56: Given buy 1 @100 then sell 3 @90, then trade A closes with an exit fill of qty 1 (`execId`) and trade B opens short with qty 2 (`execId:flip`), fee split 1/3 : 2/3.
- [ ] AC-57: Given no open journal trade for a symbol: a sell with `closedSize = qty = 5` creates no trade and warns; a **buy** with `closedSize = qty = 3` (closing an unseen short) creates no trade and warns; a buy of 5 with `closedSize 2` and fee 10 opens a long of 3 as `execId:flip` with fee 6. Given a `Funding` execution in the list, it is ignored; given a `Settle` execution or one without `closedSize`, the sync fails and the journal is unchanged.
- [ ] AC-58: Given a re-sync returning the same executions plus one new exit, then plan links, notes and an owner-set `thesis_invalidated` exitKind are preserved and fills are not duplicated.
- [ ] AC-59: Given `journalStartTime` null, then `syncFromExchange` makes zero REST calls and returns `status:"failed"`, `error:"manual.journalStartTime not set"`.
- [ ] AC-60: Given the funding history call rejects, then `status:"failed"` and the returned journal deep-equals the input.
- [ ] AC-61: Exit classification table: BustTrade → liquidation; unplanned → unknown; long plan ref 100 stop 90 target 120 maxHoldDays 5: avgExit 92 → stop; 118 → target; 116 → discretionary (if before the hold limit); 105 after 4 d 23 h → time; 105 after 1 d → discretionary.
- [ ] AC-62: Given a link request whose trade entry time is after `plan.expiresAt`, or whose side differs, then 409 and the trade is unchanged.
- [ ] AC-63: Given closed live trades with net PnL −4, −4, −4 on the same UTC day and `maxDailyLossPercent 10`, `maxCapitalUsd 100`, then `computeBreaker` is tripped with trigger `dailyLoss`; given the same trades on a previous day and nothing today, then not tripped by `dailyLoss`.
- [ ] AC-63a: Given closed live trades today with net PnL −6, −6, +10 (`maxDailyLossPercent 10`, `maxCapitalUsd 100`), then `computeBreaker` is tripped (`dailyLoss`, from the second trade) even though final equity is 98; on the next UTC day with no new trades it is not tripped by `dailyLoss`.
- [ ] AC-63c: Given 5 consecutive losing live trades (−1 each) on day 1 and one +3 winner on day 3, with `maxConsecutiveLosses 5` and `breakerResetAt` null, then on day 3 `computeBreaker` is tripped (`consecutiveLosses`); with `breakerResetAt` set between the 5th loss and the winner, then not tripped. Given a `drawdown` trip followed by recovery above the threshold without a reset, then still tripped.
- [ ] AC-63d: Given one losing trade exiting at 23:30 UTC day 1 (−6) and one exiting at 00:30 UTC day 2 (−6), `maxDailyLossPercent 10`, then no `dailyLoss` trip (each day loses 6%), proving per-trade exit times drive the rollover; and given two −6 trades at 00:30 and 01:30 UTC day 2 after a flat day 1, then `dailyLoss` trips (12%) — the day's first loss is counted.
- [ ] AC-63b: Given an open bybit-live APT/USDT trade and `config.symbols` no longer containing APT/USDT, then sync still fetches APT/USDT from the trade's newest fill − 1 h, closes the trade when its exit arrives, and `warnings` names APT/USDT.
- [ ] AC-64: Given a corrupt journal with all backups corrupt, then `research:daily` exits 5 and writes no report; given no journal file, then it runs with 0 open trades.
- [ ] AC-65: Given 2 open journal trades and `maxOpenManualTrades 3`, then at most 1 plan is produced in the run.
- [ ] AC-66: Given a request with `Host: evil.example:3082`, or a POST with `Origin: http://evil.example`, then 403 and no journal write.
- [ ] AC-67: Given a long paper entry at 100 and exit at 110 for a plan with quantity 1, `roundTripFeePercent 0.11`, then fees 0.055 + 0.0605 and `netPnlUsd = 9.8845`.
- [ ] AC-68: Given no `BYBIT_READONLY_API_KEY`, then the server starts, serves `GET /`, and `/api/state` reports `liveSync: "disabled"`.

### 6.6 Dashboard behavior **[manual]** + smoke
- [ ] AC-37 [manual]: With one open paper trade and one closed paper trade, `GET /` shows live panel (mark, uPnL, distance to stop %, distance to liq %, funding, thesis state, alerts) and review panel (planned vs actual, R, MAE/MFE, slippage, exit kind, notes); owner signs off with a screenshot committed to `docs/validation/journal-dashboard-<date>.png`.
- [ ] AC-38 [manual]: Kill network for > `staleAfterMs`; the live panel shows `STALE since <time>` and blanks P&L.

### 6.7 Persona (P1)
- [ ] AC-39 [manual]: `.claude/skills/crypto-fundamental-analyst/SKILL.md` exists, was generated through gentle-ai `skill-creator`, has valid frontmatter, and its instructions state: (a) only discuss rule outputs present in a report or proposed rule definitions in `research-rules.json` format; (b) cite §2.2 evidence IDs and strength for every claim; (c) never state buy/sell/size for anything not in a report's `plans`; (d) always include the §5.6 disclaimer. Owner runs it once on a real report and confirms (a)–(d) hold.
  *Hardening (2026-09-17, skill 1.1, owner request "always updated on news and the theory"):* the persona may use the Claude Code web search tool under the same discipline as §5.13's batch channel — (e) it cites only URLs a search returned in the same session, tags each item `confirmed` / `unconfirmed` / `contradicts` against the report's features, and the report's feature value wins for any number; news never changes a plan or fills a missing feature; (f) it states the report's staleness (decisionTime, now, expired plans) before any assessment; (g) it applies a method reference (`references/theory.md`: catalyst families mapped to features and §2.2 rows, thesis checklist, order of examination, named errors) and gives a `support`/`caution`/`oppose` stance on every plan, AI plans included, as commentary only. `tests/persona-skill.test.ts` checks (a)–(g) mechanically; the owner run covers behaviour. §11 is unchanged: the persona still produces no plans and writes nothing. *(That last sentence is superseded by the revision-3 amendment below: the persona now produces one decision, still writes nothing.)*
  *Revision 3 amendment (2026-09-17, owner requirement 1 — the persona becomes the decision layer, §5.15, §6.9):*
  (a) is widened to allow **one** further output — a `DailyDecisionInput` / `ManageInput` / `ReviewInput` JSON
  block, whose `choice` may name a plan present in that date's report or carry an idea of the persona's own —
  and (c) is restated as: **never state size, leverage, venue, stop price, target price or quantity that the
  persona itself computed**; a plan's numbers may only be restated from the report or from a Plan Report the
  CLI produced. (b), (d), (e), (f), (g) are unchanged. The persona still writes no file: the JSON block is
  handed to `npm run decide`, which is the only writer (P9). `tests/persona-skill.test.ts` gains the checks in
  AC-110/AC-116.

### 6.7a Trade chart & replay (P1 — review tooling, not a capital gate)
- [ ] AC-69: `dailySigmaBeforeEntry` on 8 daily closes [100,101,99,102,100,103,101,104] with all closes before entry equals the sample stdev of their 7 log returns (±1e-12); adding a 9th bar whose close time is after entry does not change the result; with 7 eligible bars it returns null.
- [ ] AC-70: `volatilityBand(100, T, 0.02, [T, T + 4 d])` → at T all four bounds are 100; at T + 4 d `upper1 = 100·e^0.04`, `lower1 = 100·e^−0.04`, `upper2 = 100·e^0.08`, `lower2 = 100·e^−0.08` (±1e-9).
- [ ] AC-71: `fetchKlines` over 400 hours of 1 h bars with a fake API serving ≤ 200 bars per page returns exactly 400 ascending, deduped bars; any page error or malformed bar returns null (never a partial series). `reviewClosedTrade` for a 240 h trade receives all 240 bars.
- [ ] AC-72: `chooseInterval` → "15" for a 48 h span, "60" for 48 h + 1 ms.
- [ ] AC-73: `GET /api/trades/:id/chart` → 404 for an unknown id; with the kline fetch failing → 200, `dataStatus:"unavailable"`, `candles: []`, `band: null`; for an open paper long (entry 100, qty 2, fees 0.2) with last closed candle 105 → `pnl = {kind:"unrealized", usd: 9.8, basis: "last 15m close"}`.
- [ ] AC-74: `revealCandles(c, 3)` returns the first 4 candles; cursor −5 → first 1; cursor 999 → all.
- [ ] AC-75 [manual]: With one closed and one open paper trade: the chart shows levels, markers and band; Play animates the closed trade from entry; dragging back on the open trade stops auto-follow until `LIVE` is pressed; a failed data fetch shows the reason instead of a line. Screenshot `docs/validation/trade-chart-<date>.png`.

### 6.8 AI analyst (P0 for the AI channel; the rules channel does not depend on it)
All tests use a fake `AiClientPort`; no test calls the network.
- [x] AC-40: Given the port returns each `failed` reason in turn, when `runAiAnalyst` runs, then `status === "unavailable"`, `reason` contains the failure reason, `plans` and `assessments` are empty, and the rules report written before the call is byte-identical afterward except for the `aiAnalyst` section.
- [x] AC-40a: `createClaudeCliAiClient`, given a fake `deps.spawn` replaying a real recorded CLI stream (`tests/fixtures/research/claude-cli-stream.jsonl`), returns `ok` with `structured_output` parsed, `webResults` extracted from every `tool_use_result.results[].content[]` in order, usage summed from `modelUsage` (never the terminal event's `usage.server_tool_use.web_search_requests`), `servedByModel` the `modelUsage` keys joined by `,`, `listCostUsd` from `total_cost_usd`, and the raw event array written once (a second call for the same date does not overwrite it). *(`tests/ai-claude-cli-client.test.ts`, "ok: replays the recorded fixture...")*
- [x] AC-40b: `createClaudeCliAiClient`'s spawned args include `--json-schema` with the exact output-schema string, `--model`/`--effort` from cfg, `--allowedTools WebSearch` (with `--tools WebSearch`) when `webSearchMaxUses > 0` else `--tools ""` (and no `--allowedTools`), and never `--bare`; the spawned child's env has `ANTHROPIC_API_KEY` removed when `CLAUDE_CODE_OAUTH_TOKEN` is set. *(`tests/ai-claude-cli-client.test.ts`, the two "args:" tests)*
- [x] AC-40c: `createClaudeCliAiClient` maps `subtype: "error_max_structured_output_retries"` → `schema_invalid`, `"error_max_turns"` → `max_tokens`, `is_error: true` with result text matching `/401|auth/i` / `/429|rate limit/i` / `/refus/i` → `api_error` (naming `CLAUDE_CODE_OAUTH_TOKEN`) / `rate_limited` / `refusal`; a `structured_output` failing the zod schema → `schema_invalid`; a timeout kills the child and resolves `timeout`; a spawn `error` event, no credential, and an unwritable `snapshotRoot` all resolve (never reject) with `no_api_key`/`api_error` as appropriate, and no credential means `deps.spawn` is never called. *(`tests/ai-claude-cli-client.test.ts`, all remaining tests)*
- [x] AC-41: Given AI enabled and a fake port returning a valid output, then every rule plan in the final report deep-equals the same plan from a run with `--no-ai` (AI never modifies rule plans).
- [x] AC-42: Given an idea citing `{kind:"feature", symbol:"BTC/USDT", feature:"fundingRate8hAvg3d", value: 0.0002}` while the FeatureVector value is `0.0003`, then the idea is absent from `ideas`/`plans` and `rejected` contains `{path:"ideas[0]", reason:"unverifiable_feature"}`.
- [x] AC-43: Given an idea citing a web URL not present in `webResults`, then it is rejected with `unverifiable_web`; given the URL present, it is kept.
- [x] AC-44: Given an assessment for a `planId` not in `rulePlans`, then it is rejected `unknown_plan`; given an idea on a symbol not in `configSymbols`, then `symbol_not_configured`; given an idea with zero refs, then `no_evidence`.
- [x] AC-45: Given 5 verified ideas and `maxIdeasPerDay = 3`, then exactly the first 3 remain and 2 items are rejected `over_limit`.
- [x] AC-46: Given `ai.channelStatus = "experimental"`, or `"paper-passed"` with `passedPromptHash` ≠ the current hash, then every AI plan has `origin:"ai-analyst"`, `leverage: 1`, `venueIntent:"paper"`.
- [x] AC-47: Given `monthToDateSpendUsd >= monthlyBudgetUsd`, then the fake port's `analyze` call count is 0 and `status === "skipped_budget"`.
- [x] AC-48: Given a `failed` result carrying usage, then one ledger line is appended with that usage and `resultKind:"failed"`.
- [x] AC-49: Given any change to the system prompt text, output schema, model, effort, maxTokens, webSearchMaxUses, maxIdeasPerDay, or `provider`, then `promptVersionHash` changes; given a change only to monthlyBudgetUsd, pricing fields, `cliPath`, timeoutMs, channelStatus or passedPromptHash, it is identical.
- [x] AC-49a: Given `aiDisabledReason: null`, when `buildReport` runs, then `aiAnalyst.status === "pending"` and `reason === ""`; given `"config"`, then `"disabled"` with reason `"ai.enabled is false"`; given `"cli-flag"`, then `"disabled"` with reason `"--no-ai"`.
- [x] AC-49b: Given a report file for today whose `aiAnalyst.status === "pending"` and no `--refetch`, when `research:daily` runs, then it exits 3 and prints `AI step incomplete for <date>; rerun with --refetch`.
- [x] AC-50: Given closed rule-origin reviews with AI stances [support +1R, support +2R, oppose −1R, none +0.5R], then `byAiStance.support = {closed:2, expectancyR:1.5, winRate:1}`, `byAiStance.oppose = {closed:1, expectancyR:-1, winRate:0}`, `byAiStance.caution.closed = 0`; AI-origin reviews do not appear in `byAiStance`.
- [x] AC-51: Given no `ANTHROPIC_API_KEY` and no SDK credential, then `research:daily` exits 0 with `aiAnalyst.status === "unavailable"`, reason `no_api_key`.
- [x] AC-52: `renderReportMarkdown` output contains the heading `AI analyst channel — forward-only, unvalidated` exactly once when `aiAnalyst.status !== "disabled"`, and every AI plan appears only under it.
- [x] AC-53: Given an open AI-origin trade whose `data/ai-rules/<planId>.json` is missing, then its `openTradeThesis.state === "not_evaluable"`.
- [ ] AC-54 [manual]: One live call with a real key on a real day's snapshot: response parses, `rawResponsePath` exists, ledger cost within ±20% of the Anthropic console's reported cost for that request (this also verifies `webSearchUsdPerRequest`, A16); owner reads the AI section and signs off in `docs/validation/ai-analyst-smoke-<date>.md`.
- [ ] AC-54a [manual, claude-cli]: One live CLI run on a real day's snapshot: structured output parses, raw file exists, `listCostUsd` recorded, owner reads the AI section and signs off in `docs/validation/ai-analyst-smoke-<date>.md`.

### 6.9 Persona decision channel (P0 for that channel; revision 3, Phase 6)

The rules and AI channels do not depend on any of these. No test calls the network or an LLM: every test
feeds `runDecide` a JSON block and fixture report/journal/rules files. Numbering starts at AC-98 because
AC-70..AC-97 are already taken by §6.4 and §6.7a; AC-113a/b, AC-114a and AC-119 were added in critique
round 1 (per-trade manage/review keying), and AC-99a, AC-120, AC-121 and AC-122 in round 2
(`thesis_mismatch`, the skill's D1-reset sentence, `--revise` sync freshness). The `[manual]` AC-116 is
listed last because it is the owner's end-to-end run, not a unit test.

- [x] AC-98: Given a fixture report for `2026-09-18` containing rule plan `P` (`kind:"plan"`, origin `rules-file`) and an input choosing `{kind:"report-plan", planId: P.planId}` with a stance for every `kind:"plan"` plan, when `runDecide --mode plan` runs, then exit 0; `data/decisions/2026-09-18.json` exists with `plan.origin === "persona"`, `plan.ruleId === "persona-" + skillHash.slice(0,8)`, `plan.ruleHash === skillHash`, `plan.planId === "2026-09-18:persona-<hash8>:BTC/USDT"`, `basedOnPlanId === P.planId`, `basedOnRuleKey === "<P.ruleId>@<P.ruleHash.slice(0,8)>"`, and `reports/2026-09-18.decision.md` exists.
- [x] AC-99: **Sizing equality — same status on both sides.** Given AC-98's inputs with the source rule's `status: "experimental"`, `persona.channelStatus: "experimental"` and `persona.passedSkillHash: null` (so both rules resolve to the same status), then the written `plan` equals `P` within 1e-9 in **every** sizing and level field: `symbol`, `side`, `referencePrice`, `stopPrice`, `targetPrice`, `expiresAt`, `quantity`, `notionalUsd`, `riskUsd`, `leverage`, `marginUsd`, `estLiquidationPrice`, `liqToStopRatio`, `estRoundTripFeeUsd`, `venueIntent` and `maxHoldDays`. Only `planId`, `ruleId`, `ruleHash`, `origin`, `basedOnPlanId` and `basedOnRuleKey` differ.
- [x] AC-99a: **Sizing equality — persona channel behind the source rule.** Given the same inputs but the source rule at `status: "paper-passed"` (so `P` has `venueIntent: "live"` and `leverage` from the §8.3 ladder) while `persona.channelStatus: "experimental"`, then `referencePrice`, `stopPrice`, `targetPrice`, `expiresAt` and `maxHoldDays` still equal `P`'s within 1e-9, and `leverage === 1`, `venueIntent === "paper"` — the persona channel's own gate governs (§8.5). `quantity`, `notionalUsd`, `riskUsd`, `marginUsd`, `estLiquidationPrice` and `liqToStopRatio` are those the planner returns for leverage 1 from the same inputs, not `P`'s.
- [x] AC-100: **Persona idea sizing.** Given AC-11's numeric inputs and a `persona-idea` with `stopAtrMultiple 2`, `targetRMultiple 2`, one feature ref matching the report's `close`, then the plan has `riskUsd 1`, `quantity 0.0005`, `notionalUsd 30`, `stopPrice 58000`, `targetPrice 64000`, `leverage 1`, `venueIntent "paper"` and `planId "2026-09-18:persona-<hash8>:BTC/USDT"` (±1e-9).
- [x] AC-101: Given a `persona-idea` ref `{kind:"feature", symbol:"BTC/USDT", feature:"fundingRate8hAvg3d", value:0.0002}` while the FeatureVector holds `0.0003`, then exit 2, `rejections` contains `{code:"unverifiable_feature", path:"choice.idea.refs[0]"}`, and neither `data/decisions/2026-09-18.json` nor `reports/2026-09-18.decision.md` exists.
- [x] AC-102: Given an idea whose only ref is `{kind:"web"}`, then exit 2 with `web_only_evidence`; given zero refs, `no_evidence`; given one matching feature ref **plus** the web ref, then exit 0 and the written decision's `validation.unverifiedWebRefs` contains that url, and Plan Report §6 contains it with the word `unverified`.
- [x] AC-103: Given an idea on `SOL/USDT` while `config.symbols` is `["BTC/USDT","ETH/USDT"]`, then exit 2 `symbol_not_configured`; given `confidence 1.5`, `stopAtrMultiple 0`, `targetRMultiple 21` or `maxHoldDays 11`, then exit 2 `out_of_range` with one rejection per offending field.
- [x] AC-104: Given a report with 3 `kind:"plan"` plans and stances for only 2, then exit 2 with exactly one `missing_stance` whose `path` is the un-stanced `planId`; given a stance for a `planId` not in the report, `unknown_plan`; given two stances for the same `planId`, `duplicate_stance`; given a stance for a `kind:"rejected"` entry, `unknown_plan`.
- [x] AC-105: Given `now > P.expiresAt` and a `report-plan` choice naming `P`, then exit 2 `expired` and nothing is written; given the same `now` with a `persona-idea` choice, then exit 0 (a fresh idea carries its own window, `ownerProtocol.executeUntil = decidedAt + executionWindowMs`).
- [x] AC-106: Given `{kind:"no-trade", reason:"   "}`, then exit 2 `empty_reason`; given `{kind:"no-trade", reason:"breaker tripped and no thesis survives the CPI print"}`, then exit 0, the decision has `plan: null` and `ownerProtocol: null`, and the Plan Report's section 1 is `**No trade today.**` followed by the reason, while section 2's timeline table, section 4's stances table and section 7's other-open-positions table are still present.
- [x] AC-107: **Write-once.** Given a successful run, when `runDecide` runs again for the same date without `--revise`, then exit 3 and `data/decisions/<date>.json`'s bytes are unchanged; with `--revise`, then exit 0, `<date>.r1.json` is written, `<date>.json` is still byte-identical, a third run with `--revise` writes `<date>.r2.json`, and `reports/<date>.decision.md` renders the r2 decision.
- [x] AC-108: Given a journal containing a trade whose `planId` equals the effective decision's `plan.planId`, when `runDecide --revise` runs, then exit 3, the message names that trade id, and no file is written or modified.
- [x] AC-109: Given no `reports/<date>.json`, then exit 3 with a message containing `run research:daily first`; given a `manual-journal.json` whose file and all 5 backups are corrupt, then exit 5 and nothing written; given `--date 2099-01-01`, then exit 4; given a `--skill-root` missing `SKILL.md`, then exit 5 (`SkillHashError`) and nothing written.
- [x] AC-110: **skillHash sensitivity.** Given one byte changed in `SKILL.md`, in any `references/*.md`, in any `assets/*`, or in `prompts/ai-analyst.md`, then `skillHash` changes and so does the persona rule id `persona-<hash8>`; given a **new file added under `references/` with a non-`.md` extension** (e.g. `references/checklist.txt` or `references/table.csv`), then it changes too — the file set is every regular file under the skill root, not a `*.md` glob (§5.15); given a file's trailing newline changed from LF to CRLF, then it changes (raw bytes, no normalisation); given only file mtimes change, or a dotfile is added under the skill root, or `config.json`'s `persona.executionWindowMs` / `maxEntryGapAtr` / `channelStatus` / `passedSkillHash` change, then `skillHash` is identical; given the same tree hashed twice, then the two values are equal (path order is byte order, not locale collation).
- [x] AC-111: **Gating.** Given `persona.channelStatus "experimental"`, or `"paper-passed"` with `passedSkillHash` ≠ the current `skillHash`, then `personaIdeaToRule` and `reportPlanToPersonaRule` return `status:"experimental"` and every persona plan has `leverage 1`, `venueIntent "paper"`; given `"paper-passed"` with a matching hash, then `status:"paper-passed"` and `effectiveMaxLeverage` applies the §8.3 ladder (`liveLadderCap` for the first 20 closed live persona trades).
- [x] AC-112: **Plan Report contents.** Given AC-98's decision, then `reports/<date>.decision.md` contains: the execute window rendered as both `<from> UTC → <until> UTC` and the same two instants in `persona.ownerTimeZone`; the gap-rule band `[referencePrice − 0.25·atr14d, referencePrice + 0.25·atr14d]` with both bounds; exactly three order rows, of which the stop and take-profit rows say `yes` in the reduce-only column and the entry row says `no`; a `| When | You do | Then |` table with at least one row whose *When* cell contains `Position closed`, one containing `still open`, one containing `00:15 UTC`, one naming the `maxHoldDays` time-exit date, and one intraday row whose *You do* cell contains both literals `journal dashboard` and `alerts only`; the per-trade artifact paths `data/decisions/<date>.manage.` and `data/decisions/<date>.review.` (never the date-only `…<date>.manage.json` form); the `planId` in the recording instruction; and the §5.6 disclaimer as the last non-empty line.
- [x] AC-113: **Manage mode (per trade).** Given an open journal trade `A` with `plannedSnapshot` long, referencePrice 100, stopPrice 90: `--mode manage --trade A` with `{kind:"tighten-stop", price: 85}` → exit 2 `out_of_range`; with `price: 101` → exit 2 `out_of_range`; with `price: 95` → exit 0 and `data/decisions/<date>.manage.A.json` holds that one action, `tradeId: "A"` and `currentStopPrice: 90`; with `{kind:"hold"}` and empty `reasons` → exit 2 `empty_reason`; with a `tradeId` no journal trade has → exit 2 `trade_not_found`; with a `tradeId` that is `closed` → exit 2 `trade_not_open`; with an open but unplanned trade (`plannedSnapshot === null`) → exit 2 `trade_not_planned`; with no `--trade` at all, or with `--trade` on `--mode plan`, or with a `--trade` that differs from the block's `tradeId` → exit 2 (`schema_invalid` / `date_mismatch` respectively).
- [x] AC-113a: **Two trades managed the same day.** Given open trades `A` and `B` and the same `--date`: `--mode manage --trade A` then `--mode manage --trade B` both exit 0 and write `…manage.A.json` and `…manage.B.json`; neither file's bytes change when the other is written; a **second** `--trade A` run that date without `--revise` → exit 3 naming `A` while `…manage.B.json` is untouched; with `--revise` → `…manage.A.r1.json` is written and `…manage.A.json` stays byte-identical.
- [x] AC-113b: **Acted-on manage decisions are not revisable.** Given `…manage.A.json` written at `writtenAt`, when trade `A` subsequently gains an exit fill, a changed `exitKind`, a `status: "closed"`, or any `updatedAt > writtenAt`, then `--mode manage --trade A --revise` exits 3, names the trade, and writes nothing (mirrors AC-108); with no such later journal event, `--revise` succeeds.
- [x] AC-114: **Review mode (per trade).** Given a closed journal trade `A` whose `reviewClosedTrade` gives `rMultiple -1.1`, `exitKind "stop"`, `followedPlan true`: `--mode review --trade A` with `rMultiple: -1.1`, matching `exitKind`/`followedPlan` and a non-empty `lesson` → exit 0 and `data/decisions/<date>.review.A.json` contains `tradeId: "A"`, `input` and `computed`; with `rMultiple: -0.9` → exit 2 `out_of_range`; with `exitKind: "target"` → exit 2 `out_of_range`; with an empty `lesson` → exit 2 `empty_reason`; with a still-open trade → exit 2 `trade_not_closed`; with an unknown id → exit 2 `trade_not_found`; with no `--trade` → exit 2.
- [x] AC-114a: **Two trades reviewed the same day.** Given closed trades `A` and `B` reviewed on the same `--date`, then `…review.A.json` and `…review.B.json` both exist and neither is overwritten or shadowed by the other; a second review of `A` that date without `--revise` → exit 3 naming `A`.
- [x] AC-115: **Symbols.** Given the shipped `research-rules.json`, then every rule's `symbols` is a subset of `["BTC/USDT","ETH/USDT"]` and no rule lists any other symbol; given a rule listing a symbol outside `config.symbols`, then `parseRuleSet` still raises a validation issue (existing behaviour, AC-8); given a persona idea or an AI idea outside `config.symbols`, then it is rejected (`symbol_not_configured`, AC-103 / AC-44). `config.symbols` is not hard-coded anywhere in `src/` — the pair is a config value (§13 A27).
- [x] AC-117: **Linking a persona plan.** Given a decision file whose `plan.planId` is `2026-09-18:persona-<hash8>:BTC/USDT` and a journal trade entered inside `[decidedAt, ownerProtocol.executeUntil]`, then `POST /api/trades/:id/link` with that planId returns 200, sets `plannedSnapshot` to that plan and `aiStanceAtPlan` to `null`; entered after `executeUntil` → 409; a planId whose decision file is absent → 404; `POST /api/paper/entry` with the same planId records a paper trade against it. A `persona-*` planId is never looked up in `reports/<date>.json`.
- [x] AC-118: **Persona thesis.** Given an open persona-origin trade and a decision file whose `personaRule.invalidateWhenAny` is met by the next day's features, then that day's report has `openTradeThesis[i].state === "invalidated"`; given the decision file missing or unreadable, then `"not_evaluable"` (never a guess).
- [x] AC-119: **Plan Report scope with other positions open.** Given one other `status:"open"` journal trade at decision time, then the Plan Report's `## 7. Other open positions` section lists exactly that trade — its `tradeId`, symbol, side, `planId` and today's `data/decisions/<date>.manage.<tradeId>.json` path — sections 1–3 mention no other trade's orders or exits, and the decision's own trade does not appear in section 7; given no other open trade, section 7 reads `None.`; given two, both rows appear.
- [x] AC-120: **`thesis_mismatch`.** Given an open rule-origin trade whose rule's `invalidateWhenAny` is met by that date's features (so `evaluateThesis` returns `invalidated`) and a `ManageInput` with `thesis: "intact"` and `action: {kind:"hold"}`, then `--mode manage --trade A` exits 2 with `{code:"thesis_mismatch", path:"thesis"}` whose detail names both states, and `data/decisions/<date>.manage.A.json` is not created; given the same input with `thesis: "invalidated"`, then exit 0. Given a persona-origin trade whose decision file is missing, the CLI computes `not_evaluable`, so `thesis: "not_evaluable"` is accepted and `thesis: "intact"` is rejected — the persona never asserts a thesis the system did not compute.
- [x] AC-121: **Skill states the D1 reset.** `tests/persona-skill.test.ts` asserts `.claude/skills/crypto-fundamental-analyst/SKILL.md` contains the literal sentence `Editing this skill restarts the persona channel's Gate D1 at zero.` (exact string, including the final period); removing or rewording it fails the test.
- [x] AC-122: **`--revise` requires a fresh journal sync.** Given `manual.staleAfterMs` 120 000 and `manual-journal.sync.json` holding `{liveSync:"enabled", status:"ok", syncedAt: now − 300_000}`, then `--mode plan --revise` and `--mode manage --trade A --revise` both exit **5** with a message containing `journal_stale: run the journal server sync first`, and nothing is written; with `syncedAt: now − 60_000` both proceed to the normal "already acted on" checks; with `status:"failed"`, or the file missing, or the file unparseable, then exit 5 (never treated as fresh); with `liveSync:"disabled"` (paper-only mode) the check is skipped and the run proceeds regardless of `syncedAt`; a **first** run without `--revise` never consults the file and never exits 5 for staleness.
- [ ] AC-116 [manual]: **First supervised cycle.** The owner runs one full cycle end to end and signs it off in `docs/validation/persona-decision-cycle-<date>.md`: (1) `npm run research:daily`; (2) asks the persona for today's decision and reads the JSON block before it runs anything; (3) `npm run decide -- --date <date>` succeeds and the owner confirms the Plan Report's numbers against `reports/<date>.json` by hand; (4) the owner places the paper orders inside the execute window and records the entry via `POST /api/paper/entry`; (5) at the next daily report the owner runs `manage open position` for that trade (`--trade <id>`) and confirms the artifact `data/decisions/<date>.manage.<tradeId>.json` matches what the persona said in chat — and, if a second position is open, that it produced its own separate artifact; (6) after the position closes, `review closed trade` produces an artifact whose `rMultiple` equals the dashboard's. The sign-off states explicitly whether the Plan Report answered "what do I place" and "when do I come back" without the owner asking a follow-up question — that is what requirement 4 is for.

### 6.10 Phase 7 hardening (P2)

Numbering continues from AC-122. None of these touch the rules, AI or persona channels; every test is a
unit test against a fixture — no network, no real `notify-send`, no real clock.

- [x] AC-123: **Coinalyze OI parses.** Given a recorded `open-interest-history` response (`tests/fixtures/research/coinalyze-oi-history-response.json`, shaped from the documented `open_interest_history`/`candlestick_oi` schema) for one symbol's daily candles, `createCoinalyzeOiAdapter(...).fetch(...)` returns `status: "ok"` with one row per candle: `field: "oi"`, `value` equal to that candle's `c`, `observedFor` equal to `candle.t * 1000`, and `availableAt` equal to `observedFor + 25h`.
- [x] AC-124: **Coinalyze OI fails closed.** Given `COINALYZE_API_KEY` unset, the snapshot is `unavailable` with a detail containing `COINALYZE_API_KEY not set` and the adapter never calls `fetch`; given a network error, `unavailable` (never throws); given a response whose shape doesn't match (missing `history`, non-array top level, non-numeric `t`/`c`), `invalid` with zero rows.
- [x] AC-125: **Coinalyze rate limiting.** `createCoinalyzeRateLimiter({capacity, refillPerMinute, deps})`'s `acquire()` resolves immediately while tokens remain; once exhausted, it calls the injected `deps.sleep` at least once before resolving, and resolves without a further sleep once the injected `deps.now()` has advanced enough for a token to refill. The live adapter calls `acquireCoinalyzeSlot()` once per requested symbol before its single HTTP request (2 symbols -> 2 acquisitions, 1 fetch call).
- [x] AC-126: **`oiChange3dPct` fallback precedence.** Given `bybit-oi` snapshot `ok` with ≥ 4 gap-free rows, the feature is a value with `sourceId: "bybit-oi"` regardless of what `coinalyze-oi`'s snapshot holds. Given `bybit-oi` `unavailable` (or `ok` with < 4 rows, or a gap) and `coinalyze-oi` snapshot `ok` with ≥ 4 gap-free rows, the feature is a value with `sourceId: "coinalyze-oi"` computed from `coinalyze-oi`'s own rows. Given both insufficient, the feature is `missing` with `sourceId: "bybit-oi"` and `reason` equal to what `bybit-oi` alone would have produced.
- [x] AC-127: **Coinalyze OI backfill.** Given a fetch stub returning the same fixture as AC-123 for the Coinalyze URL, `runBackfill` writes `data/history/coinalyze-oi.json` whose rows satisfy the same `availableAt = observedFor + 25h` formula as the live adapter (same `parseOiHistoryResponse`); given `COINALYZE_API_KEY` unset, that source's summary has `rows: 0` and a non-null `failure`, and every other source's backfill still completes (one source's failure is never fatal to the run, per this file's existing header comment).
- [x] AC-128: **Notification fires (or doesn't) on the right condition.** Given `manual.notifyOnReport: false` and no `--notify`, an injected `spawnFn` is never called after a successful run. Given either is `true`, `spawnFn` is called exactly once with `("notify-send", ["crypto-trader", "<date> report written: <n> rule plans, <m> AI plans, ai <status>"], ...)`, where `<n>`/`<m>`/`<status>` match that run's written report.
- [x] AC-129: **Notification failure is invisible to the caller.** Given a `spawnFn` that throws synchronously, or one that returns an object whose registered `"error"` listener is invoked (simulating `ENOENT`), `runResearchDaily`'s exit code and returned `report`/`markdown` are unchanged from the same run with notification disabled, and the report files on disk are identical.
- [x] AC-130: **CSV export, empty case.** Given a journal with no closed trades, `GET /api/reviews.csv` returns 200, `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="reviews-<today>.csv"`, and a body equal to exactly the header row followed by `\r\n`.
- [x] AC-131: **CSV export, one row and quoting.** Given one closed trade whose `notes` contains both a comma and a double quote (e.g. `He said "size down", so I did`), `GET /api/reviews.csv` returns exactly one data row whose columns match `reviewsToCsv`'s documented order and that trade's `reviewClosedTrade` result, and whose `notes` field is wrapped in double quotes with the internal double quote doubled (RFC 4180); an open trade in the same journal contributes no row.
- [x] AC-132: **CSV export Host check.** `GET /api/reviews.csv` with a mismatched `Host` header returns 403, identically to every other endpoint (AC-66).
- [x] AC-133 [manual]: **Live Coinalyze smoke.** With a real `COINALYZE_API_KEY`, `npm run backfill -- --from <date> --to <yesterday>` produces non-empty `data/history/coinalyze-oi.json` rows for BTC and ETH, and a live `research:daily` run's `oiChange3dPct` resolves to a value (not `missing`) for at least one symbol. **Run 2026-09-17** with the owner's key: live adapter `ok`, 10 daily rows per symbol; backfill `coinalyze-oi` 1 978 rows over 2024-01-01..2026-09-15; record and the two defects it exposed (the `_PERP` symbol grammar, and a failed source overwriting history) in `docs/validation/phase7-smoke-2026-09-17.md`. The `research:daily` half is the owner's to confirm on the next scheduled run (the daily feature still prefers `bybit-oi`, which is `ok` today).
- [x] AC-133a: **Symbol-incomplete Coinalyze response fails closed.** Given an HTTP 200 whose array omits a requested symbol (Coinalyze's answer for an unknown symbol grammar), then the snapshot is `unavailable` with a detail naming the missing symbols and `rows` empty — never `ok` with zero rows (`tests/research-sources.test.ts`).
- [x] AC-134: **The execute window never outlives the chosen plan.** Given a `report-plan` choice decided 20 minutes before that plan's `expiresAt`, then `ownerProtocol.executeUntil === plan.expiresAt` (not `decidedAt + executionWindowMs`), and the Plan Report prints that capped instant; given the same choice decided 11 h earlier, then `executeUntil === decidedAt + executionWindowMs`; given a `persona-idea` decided after the report plans' `expiresAt`, then `executeUntil === decidedAt + executionWindowMs` (uncapped, AC-105). `tests/decision-plan-report.test.ts`.

---

## 7. Error & edge behavior (fail-closed table)

Default for every row: **halt the dependent output and surface it; never substitute.**

| Case | Behavior | Stance |
|------|----------|--------|
| Source fetch fails / times out (10 s per request) | Snapshot `unavailable`; dependent features `missing`; report `incomplete`; rules → `not_evaluable`. | Closed |
| Source HTML/JSON shape changed | Snapshot `invalid`, zero rows. | Closed |
| Source stale beyond `maxStalenessMs` | Features `missing` (`stale`). Yesterday's value is never used. | Closed |
| Rate-limited (HTTP 429) | One retry after `Retry-After` (max 60 s), then `unavailable`. | Closed |
| `research-rules.json` invalid | Exit 2, no report written, all issues printed. | Closed |
| Rule references symbol not in config | Validation issue (exit 2). | Closed |
| Report already exists for date | Exit 3 unless `--refetch`, which writes `.r<n>` revisions and never overwrites. | Closed |
| Clock: run before 00:15 UTC for today's date | Exit 4 (`decision time in the future`). | Closed |
| ATR missing | `rejected: atr_missing`. | Closed |
| Liquidation not ≥ `minLiqToStopRatio` × stop distance | Reduce leverage; else `rejected: liq_too_close`. | Closed |
| Breaker tripped (daily loss / drawdown / consecutive losses, computed from `bybit-live` journal via `src/risk/circuit-breaker.ts`) | All plans `rejected: breaker_tripped`; report banner. | Closed |
| Rule `status` below `paper-passed` | `maxLeverage` forced to 1, `venueIntent: "paper"`. | Closed |
| API key has trade/withdraw permission | Server refuses to start (`TradePermissionKeyError`). | Closed |
| Exchange sync fails | Keep journal as-is; live view `stale`, P&L `null`, banner. | Closed |
| Fill not matching any plan | Imported with `planId: null`, alert `unplanned`, counts against adherence. | Closed (never auto-linked) |
| Two plans could match one position | Not auto-linked; owner links via `POST /api/trades/:id/link`. | Closed |
| Exchange liquidation price closer than stop | Alert `stop_beyond_liquidation` (red, top of page). | Closed |
| Position closed by liquidation | `exitKind: "liquidation"`, R computed from real P&L. | n/a |
| Journal file corrupt | Backup fallback; all corrupt → refuse start. | Closed |
| Holdout already evaluated 3× for a rule | `holdout_exhausted`; rule must be renamed (new `id`) and wait for new holdout window (§8.1). | Closed |
| Backtest `dev` mode touches holdout data | Non-zero exit before artifact. | Closed |
| Klines missing inside a simulated trade | Sim returns `unfilled` with reason; counted in report as data gap, not as a trade. | Closed |
| AI: API error, 429 after SDK retries (default 2), timeout, `refusal` after fallback, `max_tokens`, schema-invalid | `aiAnalyst.status: "unavailable"` with reason; no AI plans or assessments; rules report untouched; exit code unaffected. | Closed |
| AI: no API key | Same as above, reason `no_api_key`. | Closed |
| AI (provider `claude-cli`): `claude` executable missing, or spawns but not logged in / no usable credential | `aiAnalyst.status: "unavailable"`, reason `no_api_key` (missing credential, detected before spawning) or `api_error` (spawn failure, e.g. `ENOENT`); exit code unaffected; the CLI is never spawned when no credential is present. | Closed |
| Process killed after the rules report is written, before `attachAiAnalyst` | Report stays with `aiAnalyst.status: "pending"` (Markdown: `AI analyst: did not complete`); rule plans remain valid; next run for that date exits 3 until `--refetch` (AC-49b), which re-runs the AI step and appends a second ledger line. | Closed |
| AI: month-to-date spend ≥ budget, or ledger unparseable | No API call; `skipped_budget` (or `unavailable: ledger_unreadable`). | Closed |
| AI: cites a feature value that differs from the snapshot, a URL it did not retrieve, an unknown plan/trade, or no evidence | Item dropped and listed in `rejected`; never shown as fact. | Closed |
| AI: numeric field out of range (confidence, stop, target, hold) | Idea dropped (`out_of_range`). | Closed |
| AI: proposes size, leverage or venue in free text | Ignored — schema has no such fields; planner computes them (P5). | Closed |
| AI: search results contain instructions (prompt injection) | Output is schema-constrained and verified; the AI has no tools that change state; it can at worst produce a paper-only idea flagged in the AI channel. | Closed |
| AI: served by fallback model | Recorded in `servedByModel`; `promptVersionHash` is unchanged (it hashes the configured model), and the Markdown shows `served by <model>`. | n/a (visible) |
| AI: disagrees with a rule plan (`oppose`) | Rule plan unchanged; stance shown next to it and recorded on the trade (`aiStanceAtPlan`). | n/a |
| **Persona decision (revision 3):** no `reports/<date>.json` for the date | `npm run decide` exits **3**, message `no report for <date>; run research:daily first`; nothing written. | Closed |
| Persona: a decision for the date already exists and no `--revise` | Exit **3**; the existing `data/decisions/<date>.json` is byte-unchanged. | Closed |
| Persona: `--revise` but a journal trade already links to the effective decision's `plan.planId` | Exit **3**, refusing the rewrite and naming the trade id; the owner's route is `--mode manage`, not a rewritten decision. | Closed |
| Persona: `--date` unparseable, or its 00:15 UTC decision time is in the future | Exit **4**. | Closed |
| Persona: journal unreadable (all backups corrupt), `research-rules.json` unreadable/invalid, or a skill/prompt file missing (`SkillHashError`) | Exit **5**, nothing written — an unhashable skill has no track record to attribute the decision to. | Closed |
| Persona: input fails any validation row of §5.15 (unverified feature ref, web-only evidence, unknown/expired/rejected plan, missing stance, out-of-range field, empty reason) | Exit **2**, every rejection printed, nothing written. The persona fixes the block and re-runs. | Closed |
| Persona cites a web page the system cannot see | Recorded in `validation.unverifiedWebRefs` and printed in Plan Report §6 as `unverified`; never counted as an idea's evidence. | Closed |
| Persona: chosen rule changed in `research-rules.json` since the report (hash mismatch), or its `data/ai-rules/<planId>.json` is missing | Exit **2** (`rule_changed`) — the plan's thesis can no longer be reproduced or re-checked. | Closed |
| Persona: `planTrade` rejects the chosen/synthesized plan (breaker tripped, max open trades, size below min, liq too close, instrument missing) | Exit **2** (`replan_rejected`, detail = the planner reason); nothing written, because there is nothing to place. | Closed |
| Persona: two decisions wanted for one date (a second trade) | Not supported: one executed decision per date (§13 A31). A second idea waits for tomorrow's report. | Closed |
| Persona: process killed after `data/decisions/<date>.json` is written, before the Plan Report | Decision stands; re-running without `--revise` exits 3, so the owner re-renders with `--revise` (which appends `r1` rather than mutating the record) or reads the JSON directly. | Closed |
| Persona: owner misses the execute window (`decidedAt + executionWindowMs`) or the mark gaps beyond `maxEntryGapAtr × atr14d` | Do not enter. The decision stays on file, unexecuted; tomorrow's report starts a fresh cycle. Entering late is an adherence miss and is measured as one (§5.8a `followedPlan`). | Closed |
| Persona: `manage` names an unknown trade, a trade that is not open, an unplanned trade, or a "tightened" stop that widens risk or crosses the entry | Exit **2** (`trade_not_found` / `trade_not_open` / `trade_not_planned` / `out_of_range`); no artifact. One code per cause, so the rejection says what to do. | Closed |
| Persona: `--mode manage`/`--mode review` without `--trade`, with `--trade` on `--mode plan`, or with a `--trade` that differs from the block's `tradeId` | Exit **2** (`schema_invalid` / `date_mismatch`). Manage and review artifacts are keyed by `(date, tradeId)`, so an unaddressed call has no identity to write to. | Closed |
| Persona: a second `manage`/`review` for the **same** `(date, tradeId)` without `--revise` | Exit **3**; the existing artifact is byte-unchanged. A different `tradeId` on the same date is a different identity and writes normally. | Closed |
| Persona: `--revise` of a manage decision the owner has already acted on (any journal event for that trade after `writtenAt`) | Exit **3**, naming the trade; nothing written. The record of what was instructed stays as it was; the next instruction is tomorrow's manage decision. | Closed |
| Persona: `manage` block asserts a `thesis` the CLI's own `evaluateThesis` does not produce for that trade | Exit **2** (`thesis_mismatch`), detail naming both states; nothing written. The persona reports the system's state, it never asserts one — the same rule as the review mode's R check. | Closed |
| Persona: `--revise` (modes `plan`/`manage`) while the journal's last sync is missing, unparseable, `failed`, or older than `manual.staleAfterMs` | Exit **5**, `journal_stale: run the journal server sync first`; nothing written. "Already acted on" is judged from the journal, so a stale journal makes that judgement worthless — a fill may simply not be imported yet. Skipped in paper-only mode (`liveSync: "disabled"`), where there is no exchange state to be stale about. | Closed |
| Persona: `review` reports an R, exit kind or adherence that differs from the journal's computed review | Exit **2** (`out_of_range`) — the persona reports the system's numbers, it never authors them. | Closed |
| **(Phase 7)** Coinalyze: `COINALYZE_API_KEY` unset | Snapshot `unavailable`, detail names the missing env var; `oiChange3dPct` still resolves from `bybit-oi` if that alone is sufficient, else `missing` (§5.16). | Closed |
| Coinalyze: HTTP error, timeout, or response shape mismatch | Same as any other source (`unavailable` / `invalid`, zero rows); never crashes `research:daily` or `backfill`. | Closed |
| Coinalyze: 40 req/min budget exhausted | The shared token bucket queues the request until a credit refills; never surfaces a 429 to the caller. | Closed |
| `oiChange3dPct`: both `bybit-oi` and `coinalyze-oi` insufficient or unavailable | `missing`, `sourceId: "bybit-oi"`, reason is `bybit-oi`'s own — never a compound message blending both sources' failures. | Closed |
| Desktop notification: `notify-send` missing, or the spawned/attempted call fails | One `console.error` line; `research:daily`'s exit code and the already-written report files are unaffected. | Closed |
| `GET /api/reviews.csv` on a journal with no closed trades | 200, header row only. | n/a |
| `GET /api/reviews.csv` with a mismatched Host header | 403, identically to every other endpoint. | Closed |

---

## 8. Validation gates — the only path to real capital and leverage

### 8.1 Gate D0 — historical holdout (per rule)

- Data window: `2024-01-11` (first US spot BTC ETF trading day) → `2026-09-15`.
- Holdout: `2025-09-16` → `2026-09-15` (last 12 months). Development/tuning uses only data before `2025-09-16`.
- Holdout budget: 3 evaluations per `ruleId`, across all hashes, recorded in `data/validation/daily/holdout-ledger.jsonl`. Every evaluation of **any** rule against this window also tightens the significance threshold for all later ones (`alpha = 0.10 / globalEvaluationIndex`, §5.10a), so renaming a rule to get more attempts only makes every later test harder. A genuinely new holdout window requires new data and a reviewed code change to the window constants.
- Costs: taker 0.055% per side, historical funding, stop-first intrabar resolution (§5.10).
- Bootstrap: 10,000 resamples of per-trade R, seeded. Permutation control: 1,000 runs of the same rule's
  side/stop/target/hold with entry dates drawn uniformly from the holdout days where the rule's symbols had data, seeded; p = share with meanR ≥ observed.
- Pass = `verdict: "edge_confirmed"` → owner reviews artifact and sets rule `status: "holdout-passed"` (manual edit, committed).
- `forwardOnly: true` rules cannot take Gate D0; they go straight to D1 and need **60** paper trades instead of 30.

### 8.2 Gate D1 — forward paper (per rule)

- Rule at `holdout-passed` (or `forwardOnly`) produces `venueIntent: "paper"` plans. Owner records paper entries/exits via the journal at the price they *would* have used.
- Pass requires all of: ≥ 30 closed paper trades (60 if `forwardOnly`) over ≥ 45 calendar days;
  paper `expectancyR > 0`; paper `expectancyR` ≥ the 10th percentile of a 30-trade block bootstrap of the D0 holdout R distribution (skip for `forwardOnly`);
  `adherenceRate ≥ 0.90`; zero days with an `incomplete` report affecting that rule's features left unexplained in `docs/validation/d1-<ruleId>.md`.
- Artifact: `data/validation/daily/gate-d1-<ruleId>-<date>.json` produced by `npm run backtest:daily -- --rule <id> --mode d1-check` (reads journal, computes the criteria).
- Computed by `runGateD1` (§5.10); pass = `verdict: "paper_passed"` → owner sets `status: "paper-passed"`. Only then may plans have `venueIntent: "live"` and leverage > 1.

### 8.3 Leverage ladder after D1

- Enforced in code by `effectiveMaxLeverage` (§5.5): first 20 closed live trades per rule are capped at `liveLadderCap` (default 2). `riskPerTradePercent` ≤ 1 is validated by `loadConfig` (§5.11) for all of revision 1.
- After 20 live trades the cap becomes `maxLeverage`. `maxLeverage` in `config.json` stays 2 until the owner raises it, which the owner does only when live `expectancyR > 0` over ≥ 20 live trades and not below the D1 artifact's paper expectancy minus 0.25R; the commit message cites the `/api/stats` export used. This raise is a manual, owner-owned step (§13 A13).
- `ladderResetByBreaker` is true for a rule when any breaker trip occurred after its 20th live trade and fewer than 20 live trades of that rule have closed since the trip; `research:daily` derives it from the journal and a trip log `data/breaker-trips.jsonl` it appends to.

### 8.4 AI analyst channel gating

- The AI channel is gated as one `forwardOnly` rule per `promptVersionHash`: rule id `ai-analyst-<hash8>`. It never takes Gate D0 (X13: training cutoff inside the holdout).
- Gate D1 for it uses `runGateD1` with `forwardOnly: true`: ≥ 60 closed paper trades from AI-origin plans of that hash over ≥ 45 days, `expectancyR > 0`, adherence ≥ 0.90. Command: `npm run backtest:daily -- --rule ai-analyst-<hash8> --mode d1-check`.
- Any change to an input of `promptVersionHash` (§5.13: system prompt, output schema, model, effort, maxTokens, webSearchMaxUses, maxIdeasPerDay) creates a new hash and restarts the count at 0 (AC-49). After a pass, the owner sets `ai.channelStatus: "paper-passed"` and `ai.passedPromptHash` to that artifact's `ruleHash`. If the running hash differs from `passedPromptHash`, `aiIdeaToRule` yields status `experimental` (leverage 1, paper) automatically.
- The AI's *assessments of rule plans* never gate anything. Their value is reported by `byAiStance` (§5.9). If, after ≥ 30 closed rule-origin trades per stance bucket, `byAiStance.oppose.expectancyR >= byAiStance.support.expectancyR`, the dashboard shows `AI stance has no measured predictive value` on every AI stance.

### 8.5 Persona decision channel gating (revision 3)

- The persona channel is gated as **one `forwardOnly` rule per `skillHash`**: rule id `persona-<hash8>`,
  `ruleHash = skillHash` (§5.15). Every persona plan — whether it re-plans a rule plan, re-plans an AI plan, or
  sizes an idea of the persona's own — carries that id and hash, so the channel has exactly one track record.
- **It never takes Gate D0.** X13 applies to the persona's model with full force: it is the same model family,
  trained on data inside the holdout window, and its decisions are interactive and un-replayable — there is no
  honest way to simulate what it *would* have chosen on a past day. Any "backtest of the persona" is contaminated
  by construction.
- **Gate D1** uses `runGateD1` with `forwardOnly: true` (§5.10): ≥ **60** closed **paper** trades of origin
  `persona` with that `ruleHash`, over ≥ **45** calendar days, `expectancyR > 0`, `adherenceRate ≥ 0.90`,
  `unexplainedIncompleteDays === 0`. Command:
  `npm run backtest:daily -- --rule persona-<hash8> --mode d1-check`. As with `ai-analyst-*` ids (§5.10a,
  "AI ids in d1-check"), a `persona-*` id is treated as `forwardOnly`, its hash is taken from the id's 8-char
  prefix and matched against each trade's full `ruleHash`, and `d0Holdout` is `null`.
- **Until it passes, every persona plan is `venueIntent: "paper"` and `leverage: 1`** — enforced by
  `personaIdeaToRule` / `reportPlanToPersonaRule` returning `status: "experimental"` whenever
  `persona.channelStatus !== "paper-passed"` or `persona.passedSkillHash !== skillHash`, which `planTrade` and
  `effectiveMaxLeverage` then honour unchanged (AC-111). After a pass the owner sets
  `persona.channelStatus: "paper-passed"` and `persona.passedSkillHash` to that artifact's `ruleHash`, and the
  §8.3 leverage ladder applies to the persona rule exactly as to any other: `liveLadderCap` for its first 20
  closed live trades, then `maxLeverage`, with `ladderResetByBreaker` after a trip.
- **Editing the skill restarts the count at zero.** Any change to `SKILL.md`, `references/*.md`, `assets/*` or
  `prompts/ai-analyst.md` produces a new `skillHash`, hence a new rule id, hence a D1 track record starting at
  0 trades — the same rule as the AI channel's `promptVersionHash` (§8.4). The skill states this to its reader
  (§4.23) so the owner knows the cost of an edit before making it.
- **The other two channels progress only through their own paper trades.** A persona decision that picks a rule
  plan creates a `persona`-origin trade and credits the persona channel, not the rule: that rule's own Gate D1
  count is unaffected. The owner may still record paper trades for a rule or AI plan through the existing paper
  flow (`POST /api/paper/entry` with that plan's `planId`) to advance its gate. What the decision *does* record
  is `basedOnPlanId`/`basedOnRuleKey`, so `chosenByPersona` (§5.9) shows which rules the persona keeps picking
  and how those picks perform — a diagnostic, never a gate.
- The persona's **stances** on plans it did not pick gate nothing at all. They are recorded in the decision
  artifact and rendered in Plan Report §4 so they can be read back against outcomes later.

---

## 9. Phased plan

| Phase | Items | Tier |
|-------|-------|------|
| **1 — Data foundation** | §4.1 adapters (bybit klines 1d/1h, funding, OI; farside BTC/ETH; fred release dates; macro-calendar manual JSON; defillama stablecoins; fear-greed; unlocks manual JSON), §4.2 snapshot store, §4.3 features per §5.3a/§5.3b, `scripts/snapshot-daily.ts`. AC-1..7, AC-7a. (`scripts/backfill-history.ts` and §4.8 history store move to Phase 4, next to their only consumer.) | P0 |
| **2 — Rules, planner, report** | §4.4–4.6, `bybit-instruments` adapter, `ManualTradingConfig` (§5.11), `research:daily`, example `research-rules.json` (A10). Type-only stubs so the contract compiles before later phases: `ManualTrade`/`AiStance` types (implementation Phase 3), `AiAnalystSection` type (Phase 4b). Until Phase 3: `openTrades = []`, breaker not tripped, `liveClosedTradesForRule = 0`, `ladderResetByBreaker = false`. Until Phase 4b: `aiDisabledReason = "config"`. AC-8..19, AC-11a/b, AC-14a, AC-15a. | P0 |
| **3 — Journal & dashboard** | §4.11–4.14, §5.8a (RestClient additions, reconstruction, funding, exit classification, linking, paper trades, analytics formulas, breaker, research:daily wiring, server hardening). **Modifies shipped Phase 2 code:** adds `maxHoldDays` to the `kind:"plan"` variant in `src/research/planner.ts`; every construction site and fixture (`planTrade`, `src/research/report.ts`, `tests/research-planner.test.ts`, `tests/research-report.test.ts`, `tests/research-daily.test.ts`) is updated in the same change, and `research:daily` switches from its fixed Phase 2 inputs to the journal (§5.8a wiring). AC-27..38, AC-55..68 (incl. 63a–d). | P0 |
| **3b — Trade chart & replay** | §5.14: paged `fetchKlines` (replaces the 200-bar review fetch), `chart.ts`, `GET /api/trades/:id/chart`, SVG chart with replay/live follow and channel tabs in `journal.html`. AC-69..75. | P1 |
| **4 — Daily backtest & gates** | §4.8–4.10 per §5.10a: history store + `scripts/backfill-history.ts` (lags per §10.3), `fomc-history.json`, replay loop, simulation with slippage and per-row funding, seeded statistics and permutation control, `backtest:daily` dev/holdout/d1-check, ledger and artifacts. AC-20..26, AC-26a..g, AC-76..96. Also changes shipped code: `src/research/features.ts` (contiguity, §5.3a) and `src/journal/trade-analytics.ts` (`ClosedTradeReview.ruleHash`, `byRule` keyed by rule version, §5.9). | P0 |
| **4b — AI analyst** | §4.15–4.19, §5.13, `ai` config, report/Markdown integration, journal `aiStanceAtPlan`, `byOrigin`/`byAiStance`. AC-40..54. Depends on Phases 2–3. | P0 (AI channel only) |
| **5 — Persona** | §4.7 via gentle-ai `skill-creator`, sharing `prompts/ai-analyst.md`. AC-39. | P1 |
| **6 — Persona decision channel** (revision 3) | §4.20–4.23, §5.6a, §5.15: `src/decision/{types,decide,plan-report}.ts`, `scripts/decide-daily.ts`, `persona` config (§5.11), `PlanOrigin` widened to `"persona"` across `src/research/planner.ts`, `src/research/rules.ts` and `src/journal/trade-analytics.ts` (`byOrigin.persona`, `chosenByPersona`, `ClosedTradeReview.basedOnRuleKey`), the three new persona gates + `references/decision-protocol.md`, and `config.symbols` / `research-rules.json` narrowed to BTC + ETH. **Also modifies shipped Phase 2–3 code:** `src/server/journal-server.ts` resolves a `persona-*` `planId` from `data/decisions/` for `POST /api/trades/:id/link` and `POST /api/paper/entry` (§5.8a, revision-3 paragraph) **and calls `writeSyncStatus` after every sync attempt** (the sync-freshness sidecar, §5.15; `src/journal/manual-journal.ts` gains `readSyncStatus`/`writeSyncStatus`), and `src/research/report.ts`'s `openTradeThesis` step loads an open persona trade's rule from that file's `personaRule`. AC-98..AC-122. **Depends on Phases 2–5** (report, journal, gates, AI plans to choose from, and the persona skill itself). Does **not** modify `planTrade`'s body or any shipped number. | P0 (persona channel only) |
| **7 — Hardening** | §5.16: `coinalyze-oi` adapter + backfill (longer OI history, `oiChange3dPct` fallback), optional desktop notification when a report is written, `GET /api/reviews.csv`. AC-123..AC-133. | P2 |
| **8 — Retire scalper** | Separate spec decides whether to delete `src/main.ts` auto-trading loop and 5m harness. | P3 |

Phase 3 is ordered before Phase 4 so paper tracking can start as soon as rules produce plans; Gate D1 needs calendar time, Gate D0 does not.

**Go/no-go: no order with real capital may be placed from any plan of this system until Phases 1–4 are complete with all their acceptance criteria green, and the specific rule has passed Gate D0 (or is `forwardOnly`) and Gate D1 with committed artifacts reviewed by the owner; for AI-origin plans, Phase 4b must also be complete and the exact `promptVersionHash` in use must have passed Gate D1 (§8.4); for persona-origin plans, Phase 6 must also be complete and the exact `skillHash` in use must have passed Gate D1 in its forward-only form (§8.5). Until then every journal entry from this system is venue `paper` and leverage is 1. Neither the AI's support for a plan nor the persona's choice of it ever substitutes for a gate — and a persona decision that picks a rule plan does not inherit that rule's gates, it carries the persona channel's own.**

---

## 10. Constraints

### 10.1 Runtime & dependencies
- Node `>= 24` (current `v24.20.0`), TypeScript strict, ESM, `--experimental-strip-types`, no build step.
- **Exactly two new runtime dependencies, both for the AI channel only:** `@anthropic-ai/sdk` **`0.126.0`** and `zod` **`4.6.5`** (required by the SDK's `zodOutputFormat` helper; SDK peer range `^3.25.0 || ^4.0.0`). Exact pins, no `^` (latest stable per `npm view`, 2026-09-16). Any later bump is its own reviewed change that re-runs AC-40..54 and AC-54's live smoke. Only `src/research/ai/anthropic-client.ts` and its zod schema file may import them (verification gate §12.10).
- Everything else: HTTP via global `fetch`; hashing via `node:crypto`; HTML table parsing hand-written with fixtures; seeded PRNG implemented inline (mulberry32). Existing deps unchanged: `hono ^4`, `@hono/node-server ^1`, `bybit-official-ts-sdk ^0.1.0`.
- SDK usage (method names, beta flags, fallback + structured-output combination) is taken from the official SDK docs at implementation time, not from this spec's prose; if refusal fallback cannot be combined with structured output parsing, fallback is dropped and a refusal is handled as `failed: refusal` (§13 A17).
- Chart.js from CDN is acceptable in `journal.html` (same as the existing dashboard).
- The default AI provider (`claude-cli`) is an **external tool, not an npm dependency**: the locally
  installed `claude` CLI, version `>= 2.1.x` (verified against `2.1.274`). It is spawned via
  `node:child_process`, never imported as a package; gate §12.10's import restriction covers only
  `@anthropic-ai/sdk`/`zod` and does not apply to `src/research/ai/claude-cli-client.ts`.

### 10.2 Environment & external limits
- Tests must live directly in `tests/` (glob `tests/*.test.ts` is non-recursive, E11). Tests never hit the network: adapters are tested against recorded fixtures in `tests/fixtures/research/`.
- FRED requires `FRED_API_KEY` env var; missing key → source `unavailable` (not a crash). Limit 120 req/min.
- Bybit read-only key via `BYBIT_READONLY_API_KEY` / `BYBIT_READONLY_API_SECRET`; distinct env names from the auto-trader's keys so the two cannot be confused.
- Coinalyze free API: 40 req/min, requires key `COINALYZE_API_KEY` (Phase 7 — "Hardening" — only; renumbered from 6 in revision 3). Daily-granularity history is never deleted (only intraday granularities age out), which is why it is the deeper-history OI source (§5.16).
- AI credentials: never written to config, logs, reports, or snapshots. Provider `claude-cli` (default):
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), falling back to `ANTHROPIC_API_KEY` if unset —
  when the OAuth token IS set, `ANTHROPIC_API_KEY` is removed from the spawned CLI's environment so the
  subscription is always used. Provider `anthropic-api`: `ANTHROPIC_API_KEY` or the SDK's default
  credential chain. One call per day (plus retries). Requests may take minutes: streamed/spawned,
  `timeoutMs` 600 000. Web search tool type `web_search_20260209` (anthropic-api) / CLI tool
  `WebSearch` with `--allowedTools WebSearch` (claude-cli). The job must not run the AI step more than
  once per date unless `--refetch` (then the ledger records both calls).
- `data/ai-usage.jsonl` and `data/ai-rules/` are committed (audit trail); `data/snapshots/*/ai-analyst.raw.json` is gitignored like other snapshots.
- Farside may block non-browser clients; if so, adapter returns `unavailable` and the owner may drop a manual CSV at `data/manual/farside-<btc|eth>.csv` which the adapter reads with `availableAt = file mtime`.
- Bybit public market endpoints: stay under 10 req/s (reuse `src/bybit/rate-limiter.ts`).
- `data/snapshots/`, `reports/`, `manual-journal.json*` are gitignored; `data/validation/daily/*.json` and the ledger are committed. **(Revision 3)** `manual-journal.sync.json` (the sync-status sidecar, §5.15) is gitignored with the journal it belongs to — it is machine state, not a record.
- **(Revision 3)** `data/decisions/*.json` (decision, manage and review artifacts, all revisions) are **committed** — they
  are the persona channel's audit trail, the input to its Gate D1 review, and the only record of decisions that were
  never executed. The Plan Report `reports/<date>.decision.md` is **gitignored**, because `reports/` already is and the
  file is fully derived from the committed decision plus that date's report; it is regenerated by re-running
  `npm run decide -- --revise`. `npm run decide` performs no network I/O and reads no credential.

### 10.3 Declared availability lags for backfilled history (used only where no live snapshot exists)

| Source | `availableAt` rule for history | PIT history? |
|--------|-------------------------------|--------------|
| bybit klines 1d | bar close | yes |
| bybit funding | settlement time | yes |
| bybit OI | not usable before snapshots start (history too short, X6) | no → rules using `oiChange3dPct` are `forwardOnly` unless backfilled via `coinalyze-oi` (Phase 7, §5.16); `bybit-oi` itself is still not backfilled |
| coinalyze-oi (Phase 7, §5.16) | candle close (day end) + 1h cushion (no documented settlement lag published; reuses the fear-greed "+1h" convention) | yes, once backfilled (`npm run backfill`); a rule using `oiChange3dPct` no longer needs `forwardOnly` on that account once its D0 window is covered |
| farside ETF flows for US trading day D | D+1 at 12:00 UTC | yes, with lag |
| FRED release dates | scheduled release time (08:30 ET converted to UTC with DST) — schedule published ahead | yes |
| FOMC dates (manual JSON) | statement time 14:00 ET; schedule known a year ahead | yes |
| defillama stablecoins daily | D+1 at 00:00 UTC | yes, with lag (revision risk accepted, §13 A7) |
| fear & greed | D at 00:00 UTC + 1 h | yes |
| unlocks (manual JSON) | snapshot date only | no → any rule using unlock features is `forwardOnly` (X5) |

---

## 11. Out of scope

- Automated order placement, order modification, or cancellation — by any component, including the dashboard.
- Modifying or deleting `src/main.ts`, `src/strategy/*` 5m engine, or its specs (Phase 8 needs its own spec). The only shared-file change is the additive `RestClient.getApiKeyInfo()` method; `npm test` must stay green for all pre-existing tests (§12.2). **(Revision 3)** `src/main.ts` is not modified **in code**; its *behaviour* changes only through the shared `config.symbols` value, which revision 3 narrows to BTC + ETH — a knowingly accepted side effect, recorded for owner veto in §13 A33.
- Paid data (Tokenomist, DefiLlama Pro, Coinglass, CryptoPanic), a separate news NLP pipeline, social sentiment scrapers. (The AI analyst's own web search is in scope; nothing else ingests news.)
- AI output that bypasses verification, the planner, or gates; AI-chosen size, leverage or venue; AI modifying rule plans or `research-rules.json`.
- Multi-turn/agentic AI loops, AI tools other than web search, Managed Agents, Batches, multiple models or model cascades.
- **(Revision 3)** Persona output that bypasses `npm run decide`; persona-chosen size, leverage or venue; automated
  execution of a decision (by the CLI, the dashboard, or anything else); more than one persona decision per date
  executed. The persona also never writes a file, edits `research-rules.json`, `config.json` or a report, or changes a
  rule's `status`.
- ML models, parameter optimizers, or auto-tuning of rule thresholds.
- Spot trading, options, multi-exchange, cross-margin, portfolio optimization, hedging.
- Testnet as a validation venue (consistent with `specs/profit-target-roadmap.md:68`).
- Mobile UI, authentication, remote access (server is localhost-only), push notifications (P2 desktop notification only).
- Tax reporting, multi-user support.
- Scheduling infrastructure beyond documenting a `systemd --user` timer / cron line in `docs/daily-research.md`.

---

## 12. Verification gates (must all pass per phase)

1. `npm run typecheck` (= `tsc --noEmit`) — zero errors.
2. `npm test` (= `node --test --experimental-strip-types "tests/*.test.ts"`) — all green, including all pre-existing tests (365 at time of writing).
3. `rg --files tests | rg "^tests/.+/.+\.test\.ts$"` — returns nothing (no test hidden in a subdirectory).
4. `rg -n "placeOrder|createOrder|cancelOrder|setLeverage" src/research src/journal src/backtest-daily src/decision scripts/decide-daily.ts src/server/journal-server.ts` — returns nothing (P4; `src/decision` and `scripts/decide-daily.ts` added in revision 3).
5. Independent reviewer verdict `approved` on each phase's diff.
6. **[manual, Phase 1]** Live smoke: `npm run snapshot:daily` against real endpoints; every source `ok` or a documented reason; snapshot files committed to a scratch branch for review, not main.
7. **[manual, Phase 2]** Owner reads 7 consecutive daily reports and confirms each plan's numbers by hand for at least one plan per report.
8. **[manual, Phase 3]** Live read-only key test: a key *with* trade permission is rejected (AC-27 against real Bybit), then a read-only key syncs the owner's real account; AC-37/38 screenshots committed.
9. **[manual, Phase 4]** Owner review and sign-off of each `gate-d0-*.json` and `gate-d1-*.json` before editing a rule's `status`.
10. `rg -l "@anthropic-ai/sdk|from \"zod\"" src scripts` — lists only files under `src/research/ai/`.
11. `rg -n "ANTHROPIC_API_KEY|sk-ant-" reports data/ai-usage.jsonl data/ai-rules` — returns nothing (no credential leakage).
12. **[manual, Phase 4b]** AC-54 (anthropic-api) and/or AC-54a (claude-cli) live smoke, plus 7 consecutive daily runs with AI enabled where the owner confirms each AI stance's cited feature values against the report by hand for at least one assessment per day.
13. **[manual, Phase 3]** Funding sign check: hold one small real position through a funding settlement, compare the journal's `fundingUsd` sign with Bybit's transaction log (positive funding rate + long = paid). Only then set `manual.fundingSignVerified: true`. (The read-only-key checks are item 8.)
14. **(Revision 3)** `rg -n "writeFile|appendFile|mkdir|fs\." src/decision` — every hit is in `scripts/decide-daily.ts`'s call path only: `src/decision/decide.ts` and `src/decision/plan-report.ts` are pure and must contain none (the sole exception is `skillHash`, which reads the skill files and may live in its own `src/decision/skill-hash.ts`).
15. **(Revision 3)** `rg -n "data/decisions|reports/.*decision\.md" src scripts --glob '!scripts/decide-daily.ts'` — returns nothing: only the `decide` CLI writes those paths (P9).
16. **[manual, Phase 6]** AC-116's supervised cycle, signed off in `docs/validation/persona-decision-cycle-<date>.md`, plus 7 consecutive days on which the owner reads only the Plan Report before acting and records any question it failed to answer.
17. **(Phase 7)** `rg -n "COINALYZE_API_KEY=" src scripts data/history` — returns nothing (no credential leakage; the key is read only from `process.env`, never written to config, snapshots, history files, or reports).
18. **[manual, Phase 7]** Live smoke: `npm run backfill -- --from <date> --to <yesterday>` with a real `COINALYZE_API_KEY` produces non-empty `data/history/coinalyze-oi.json` rows; `notify-send` fires a real desktop notification when `manual.notifyOnReport: true`; `GET /api/reviews.csv` opens in a spreadsheet application with the expected columns.

---

## 13. Assumptions (for owner veto)

- A1: Bybit linear perps remain the only venue; symbols come from `config.symbols` (revision 3: `["BTC/USDT", "ETH/USDT"]`, A27).
- A2: Decision time 00:15 UTC fits the owner's day; manual execution happens within the plan's `expiresAt` (default 12 h).
- A3: Owner will use market (taker) orders; fees modeled at 0.055%/side. If limit orders are used, measured slippage in the journal will show it.
- A4: 1h klines are fine enough to resolve stop/target for 1–10 day holds; stop-first on ambiguity biases results pessimistically, which is intended.
- A5: 30 closed holdout trades is the minimum for a D0 verdict. This is low; it is compensated by the bootstrap-CI and permutation requirements and by Gate D1. Owner may raise it.
- A6: The holdout window is the last 12 months; the ETF-era start (2024-01-11) bounds history to ~2.7 years.
- A7: DefiLlama stablecoin history revisions are small enough to accept with a 1-day lag.
- A8: Survivorship: backtests only use symbols listed on Bybit for the whole window; the symbol list and listing dates are recorded in each artifact. Delisted-symbol bias is accepted and noted.
- A9: `riskPerTradePercent` default 1 and `marginBudgetPercent` default 25 are starting values, not optimized.
- A10: Initial rule set for Phase 2 contains three `experimental` example rules only as test fixtures of the format (ETF-flow momentum X1, pre-FOMC/CPI de-risk X2 as a "no new entries within 24 h" rule, funding-extreme contrarian X4). They are not recommendations; the owner writes the real rules. **(Revision 3)** Their `symbols` become `["BTC/USDT", "ETH/USDT"]` in the same commit as the `config.symbols` change, or every `research:daily` run exits 2 (E16). With that pair, `btcEtfNetFlowUsd*` and `ethEtfNetFlowUsd1d` apply directly to the traded symbol rather than as market context, and no example rule may use `daysToNextUnlock` / `nextUnlockPctOfFloat` — those are permanently 999 / 0 for BTC and ETH (A27).
- A11: Running the daily job is the owner's machine's responsibility (cron/systemd timer). A missed day produces no report, never a back-dated one.
- A12: The analyst persona is a Claude Code skill used interactively by the owner; it is not part of the scheduled pipeline. (Revision 3: it is now also the decision layer, but still owner-invoked — the scheduled 00:15 UTC job still runs only `research:daily`, and a day on which the owner never opens the persona simply has no decision.)
- A13: The first leverage-ladder step (cap `liveLadderCap` for 20 live trades, breaker reset) is enforced in code; raising `maxLeverage` above 2 is a deliberate manual config commit by the owner, not automated, because it is a capital decision the owner reviews.
- A14: Leverage > 1 is permitted at all only because the owner explicitly requested leveraged trading; defaults (`maxLeverage` 2, hard ceiling 5, liquidation ≥ 2× stop distance) are conservative starting points for owner veto.
- A15: The owner explicitly requested that Claude actively participate in recommendations (2026-09-16). Estimated cost per daily call ≈ $0.20–$0.60 (≈30–60k input tokens, 5–15k output, ≤5 searches) → roughly $6–$18/month, i.e. 6–18% of the current $100 capital per month. The AI channel must earn that back to be worth keeping; `byOrigin`/`byAiStance` exist to measure it. The owner may lower `effort` or choose another model; this spec does not downgrade on its own.
- A16: `webSearchUsdPerRequest = 0.01` is not verified from a primary source in this spec; AC-54 checks the ledger against the console.
- A17: The combination of streaming, structured-output parsing, web search and server-side refusal fallback in one request is assumed supported; if not, fallback is the part dropped.
- A18: The AI reads only what the input contains plus its own web search. It is not given the journal's P&L history, to avoid it anchoring on recent results.
- A19: Using an AI to generate analysis for the owner's own decisions keeps a human decision-maker on every order; the report labels AI content as generated and unvalidated.
- A20: Backtests use the **current** Bybit order-size filters for the whole window; historical changes to `minOrderQty`/`qtyStep` are not modeled.
- A21: 5 bps adverse slippage per side on top of taker fees is a conservative flat cost for 1h-bar market orders on liquid perps. The owner may raise it. Lowering it does not buy extra attempts: every holdout run, whatever its settings, consumes one of the rule's 3 ledger evaluations.
- A22: The backtest applies no circuit breaker and no cross-rule open-trade cap: Gate D0 measures one rule in isolation. The live system still enforces both.
- A23: With $100 capital and 1% risk, many historical plans will be `size_below_min`; they are not simulated, which can leave a rule at `insufficient_data`. That outcome is correct, not a defect to tune around.
- A24: **The holdout is not blind for a human author.** Rules are written in September 2026, after the owner has lived through the whole
  2025-09-16 → 2026-09-15 holdout — the same contamination that excludes the AI from Gate D0 (X13), only milder. Gate D0 is therefore a
  necessary filter, never sufficient on its own: **Gate D1 (forward paper) is the only truly out-of-sample test.** Mitigations:
  pre-registration (holdout runs require the rule to be committed; `rulesFileCommit` is recorded), the per-rule 3-run cap and the
  global Bonferroni alpha. Post-hoc tuning after a `no_edge` is visible in git history, not prevented.
- A26: Backfilled CPI release dates use `availableAt = release time − 60 days` (BLS publishes the year's schedule months ahead;
  using the release instant itself hid every upcoming release, so `hoursToNextCpi` was missing on every backtest day), and a
  backfilled schedule whose coverage extends past T is current at T for staleness. Backfilled FOMC rows use `availableAt = meeting time − 180 days` (the Fed publishes each year's schedule well ahead; exact
  publication dates aren't recorded). `hoursToNextFomc` only looks at the nearest future meeting, so this cannot change a feature
  value within the backtest window. `simulatePlan` derives decision time from the `planId` date prefix (`<date>T00:15:00Z`).
  The 2025-08-22 notation vote listed on the Fed calendar is excluded: it has no rate statement.
- A25: Pooling trades by decision day assumes trades from different days are independent enough for a day-level bootstrap. Multi-day
  holds overlapping across days still share market moves; D0 accepts that residual optimism because D1 re-tests forward.
- A27 **(revision 3)**: `config.symbols` is `["BTC/USDT", "ETH/USDT"]` — the owner's explicit choice for the start of the
  persona channel (the two deepest, most-covered instruments, and the only two for which the ETF-flow features exist at
  all). The pair is a config value, not a constant in `src/`: widening it later is a config edit plus a rules-file edit,
  not a code change. Two consequences the spec states rather than hides: `btcEtfNetFlowUsd1d`/`btcEtfNetFlowUsd5d` and
  `ethEtfNetFlowUsd1d` now apply directly to the traded symbols instead of as market-wide context, and
  `daysToNextUnlock`/`nextUnlockPctOfFloat` are permanently 999/0 for BTC and ETH (no unlock schedule), so any rule or
  idea built on the unlock family is inert for this symbol set — the example rules must not use it. **A third consequence
  reaches outside this spec's modules: `config.symbols` is shared with the untouched auto-trader — see A33.**
- A28 **(revision 3)**: The owner's local clock is UTC−3 (`persona.ownerTimeZone`, default
  `America/Argentina/Buenos_Aires`). Every absolute time in the Plan Report is printed in UTC **and** that zone, because
  a come-back instruction the owner has to convert in their head is an instruction they will get wrong once. The zone is
  config, and DST (which that zone does not currently observe) is handled by formatting the instant, never by adding a
  fixed offset.
- A29 **(revision 3)**: `persona.executionWindowMs` defaults to **6 h** — shorter than the plan's own 12 h `expiresAt`
  (A2), because the decision is taken some time after 00:15 and a stale *decision* is worse than a stale *plan*: the
  persona weighed news that keeps aging. The owner may raise it up to the plan's `expiresAt`; past that the report-plan
  choice is `expired` anyway. **The window is therefore capped at the chosen plan's own `expiresAt`** (AC-134): a decision
  taken 20 minutes before a plan expires gets a 20-minute window, not a 6-hour one. Found live — a decision at 11:53 UTC on
  2026-09-18 advertised 17:53 for a plan that expired at 12:15, and because §5.8a's link window is
  `[decidedAt, executeUntil]`, the journal then accepted a paper entry at 12:31 against an expired plan. A `persona-idea`
  is deliberately **not** capped (AC-105): the idea is new even when the day's rule plans are stale.
- A30 **(revision 3)**: `persona.maxEntryGapAtr` defaults to **0.25** ATR. Entering more than a quarter of a daily ATR
  away from `referencePrice` silently changes the trade's R: the stop distance is fixed in the plan, so the real risk and
  the real R-multiple drift from the printed ones. 0.25 is a starting value for owner veto, not a measured threshold —
  the journal's `entrySlippagePct` will show whether it is the right one.
- A31 **(revision 3)**: **One decision per date.** The persona replaces the report's plans with a single choice rather
  than adding to them, so `openTradeCount` counts only open journal trades, `data/decisions/<date>.json` is write-once,
  and a second idea waits for the next report. If the owner ever wants two concurrent persona positions, that is a new
  revision, not a `--revise`.
- A32 **(revision 3)**: The owner performs every time exit. `maxHoldDays` is printed as a hard date in the Plan Report
  and is enforced by nothing but the owner's hand — there is no scheduler, no bot and no alert that will close a position
  (P4). A missed time exit shows up as `exitKind: "discretionary"` and an adherence miss (§5.8a), which is exactly how it
  should surface: measured, not silently corrected.
- A33 **(revision 3, for explicit owner veto)**: **Narrowing `config.symbols` also narrows `src/main.ts`'s tradeable
  universe** from its current list to BTC + ETH, without any code edit — the 5-minute auto-trader reads the same field
  (`src/main.ts:518`, `:653`, `:683`, `:696`, `:698`, `:709`, `:837`, `:964`). The owner accepts this: the scalper has a
  confirmed negative edge (E1), is not in use since the pivot away from it, and is slated for retirement in Phase 8. This
  spec therefore does **not** decouple the two — a second symbol list is one more thing to keep in sync for a component
  that is being removed, and the silent-shrink surprise is cheaper to *state* than to engineer around. If the owner wants
  the scalper's universe preserved, the deferred alternative is a `research.symbols` scope (§14), and it must be chosen
  *before* the `config.symbols` edit lands, not after.

---

## 14. Considered alternatives (deferred)

- **Unconstrained LLM "analyst" issuing daily calls with its own size/leverage.** Rejected (revision 1) and still rejected in that form. Revision 2 adopts a constrained version at the owner's request: schema-bound output, verified evidence, shared planner, forward-only gate, separate attribution. Reason for the constraints: an LLM cannot be honestly backtested on data it was trained on (X13), and unverified numbers from it would enter a money decision.
- **AI as the only channel (drop rules).** Rejected: removes the only backtestable baseline and the comparison that tells the owner whether the AI adds value.
- **AI allowed to veto or resize rule plans automatically.** Deferred: its stances have no measured value yet; revisit when `byAiStance` has ≥ 30 trades per bucket.
- **Cheaper model (e.g. `claude-sonnet-5`) or lower effort.** Not chosen by this spec; an owner decision under A15.
- **Keep auto-execution, only change horizon to daily.** Deferred: manual execution was the owner's explicit requirement and removes a whole class of execution-risk findings; can be revisited after D1 via a new spec.
- **Spot swing trading without leverage.** Deferred: removes liquidation risk entirely and is the safer default for a strategy without measured edge. Remains the recommended fallback if no rule passes D1.
- **Paid point-in-time data (Tokenomist, Coinglass, DefiLlama Pro).** Deferred until a free-data rule passes D0 and a paid source would plausibly sharpen it; ~$29–$300/mo is large relative to $100 capital.
- **Full hexagonal restructuring of the existing repo.** Deferred: new modules follow ports/adapters internally; the legacy engine stays untouched until Phase 8's spec.
- **(Revision 3) The persona writing `data/decisions/` (or the report) directly.** Rejected: a file written by a chat session is unverifiable after the fact — nothing would have checked its feature citations against the snapshot, re-derived its size from `planTrade`, or refused an expired plan. Routing every decision through `npm run decide` costs one command and buys the whole fail-closed table (§7) plus a committed, hash-attributed record. This is P9.
- **(Revision 3) Persona limited to choosing among the report's plans (no ideas of its own).** Rejected by owner requirement 1: the persona may differ from both channels. The risk — an idea nobody backtested — is handled the same way the AI channel's is: forward-only, paper, its own Gate D1, verified feature citations, and a hard refusal of web-only evidence.
- **(Revision 3) Letting the persona run the daily job unattended (decide + record automatically).** Deferred: it would remove the human from the only step that is currently guaranteed human (P4), and the channel has no measured edge yet. Revisit only after §8.5's Gate D1 passes, in a new spec.
- **(Revision 3) More than one persona decision per day, or intraday re-decisions.** Deferred (§13 A31): one decision per date keeps the channel's track record one-trade-per-day and matches the once-daily data. The `manage open position` gate covers "something changed" without adding a second entry.
- **(Revision 3) A `research.symbols` scope, decoupling this system's universe from `config.symbols`.** Deferred, and the decision is A33's: `config.symbols` is read by the untouched auto-trader (`src/main.ts:518,653,683,696,698,709,837,964`), so narrowing it to BTC + ETH shrinks the scalper's universe too. A separate `research.symbols` (defaulting to `config.symbols`) would isolate the two, at the cost of a second list to keep in sync — for an engine that has a confirmed negative edge (E1) and is scheduled for deletion in Phase 8. If the owner ever wants the scalper running on its old universe alongside this system, this is the change to make, **before** narrowing `config.symbols`.
- **(Revision 3) A `mark`-price feed for the gap rule.** Deferred: `decide` is offline and the owner is at the terminal with the exchange open, so the band is printed and the owner compares. Adding a price fetch would put a network call (and a fresh failure mode) into the only step that has none.
- **Reusing `src/learning/journal.ts` by extending `TradeRecord`.** Rejected: its `indicatorsAtEntry` shape (E6) and auto-trader coupling would leak scalping concerns; a separate `ManualTrade` store reuses only the durability pattern (E7).
