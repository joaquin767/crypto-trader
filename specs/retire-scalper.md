# Retire the 5-Minute Auto-Trader — Audit & Deletion Spec (Phase 8)

> **Accepted** by the spec factory (rubric v2, score 23/24, 1 round). The two round-1 weaknesses were
> fixed and applied after acceptance: E5's citation (it credited `scripts/exit-mix.ts:126` with
> importing `median` from `walkforward.ts`; that file defines its own local helpers at `:68`/`:74` and
> imports nothing from `walkforward.ts` — the conclusion held, the evidence did not, which is exactly
> the L-006 failure mode) and AC-19's unobservable "exits cleanly on SIGINT". Fixing the second turned
> up a third defect the critique had not asked for: the obvious replacement ("exit code 0 within 2 s")
> is also wrong, because `journal-server.ts` installs no signal handler and so dies to `SIGINT`'s
> default action with status 130. AC-19 now asserts what this phase can actually break, and §13 defers
> the handler.
>
> Written against rubric v2, lessons L-001..L-010. Every finding in §2 was produced by reading the
> code, running the test suite and walking the import graph in this repository — not from memory
> (L-009).

**Measurement basis — read this before checking any number in this document.** Every count, line
reference, file total and test total below was measured at commit **`65988db`**, which was the tip of
`feat/phase7-hardening` when this spec was written (Node `v24.20.0`). Phase 7 ("Hardening",
`specs/daily-catalyst-manual-trading.md:2219`) has since landed further work on that branch — a
`coinalyze-oi` source and §5.16, a notification flag, a CSV endpoint. **None of those files appear in
any delete, trim or rewrite list in §5, and none of this spec's numbers have been restated against
them.** The stated numbers are therefore checkable as written by `git checkout 65988db` (or
`git show 65988db:<path>`), and are what the phase gates in §8 compare against. Two consequences an
implementer must act on: (a) the test totals in AC-8/AC-9 (549, then 521) are *deltas from 833 at
`65988db`* — if Phase 7 added tests, add its delta to both and record the arithmetic in the commit
message, because the rule that matters is "833 − 284 − 28", not the literal integers; (b) before
step 8b, re-run §5.1's reachability check on the then-current tree to confirm Phase 7 introduced no
new import of a delete-set module (§7 covers the case where it did).

**Reachability confirmed for Phase 7 (2026-09-17, at `31ab644`).** The check in (b) was run against
the Phase 7 tip before this spec was merged: the only import of a delete-set module from daily code
is still `src/backtest-daily/stats.ts:11` (`percentile` from `src/strategy/walkforward.ts`, finding
F1). Phase 7's new files reach into shared, non-delete-set code only —
`src/research/sources/coinalyze-oi.ts:12` imports `appSymbolToBybit` from `src/bybit/adapters.ts`
(kept and trimmed, §5.4), exactly as the five pre-existing Bybit source adapters already do. Test
totals moved 833 → 858 on that branch (+25: Phase 7's own ACs plus two regression tests from its live
smoke), so the AC-8/AC-9 arithmetic an implementer must record is `858 − 284 − 28 = 546`, unless the
count has moved again by then — re-measure, do not trust this line as final.

Status: **Accepted. This spec is the decision and the plan; no code moves until step 8a is started
deliberately.**

Owner (every path this spec deletes, trims or rewrites):
`src/main.ts`, `src/tui.ts`, `src/logger.ts`, `src/instance-lock.ts`, `src/startup-safety.ts`,
`src/executor.ts`, `src/market.ts`, `src/portfolio.ts`, `src/server/index.ts`,
`src/server/public/index.html`, `src/bybit/{connector,ws,pending-orders}.ts`,
`src/risk/wallet-monitor.ts`, `src/learning/`, `src/strategy/`,
`scripts/{train-model,walk-forward,backtest,fetch-klines,export-folds,crosscheck-export,barrier-sweep,exit-mix}.ts`,
`scripts/auc_feasibility.py`, `crosscheck/`, 23 files under `tests/`,
`tests/fixtures/aptusdt-klines-15m.json`, `data/model/scalping-model.json`;
**trimmed, not deleted:** `src/config.ts`, `src/bybit/{adapters,rest,types}.ts`,
`src/risk/circuit-breaker.ts`, `tests/{bybit,rest-client,circuit-breaker,config}.test.ts`,
`.gitignore`, `package.json`, `config.template.json`;
**one addition:** `percentile` moves into `src/backtest-daily/stats.ts`;
**rewritten:** `README.md`, `AGENTS.md`, `docs/SETUP.md`, `docs/BYBIT_INTEGRATION.md`,
`docs/DAILY_WORKFLOW.md:549-551`;
**deleted docs:** `docs/{ARCHITECTURE,STRATEGY,USER_GUIDE,RISK_MANAGEMENT}.md`;
**header-only edit:** `specs/{profit-target-roadmap,strategy-signal-quality,live-trading-readiness}.md`.

Purpose: `specs/daily-catalyst-manual-trading.md` §9 defers to a separate spec the question of whether
to delete the 5-minute auto-trading loop and its harness. **This spec answers it: delete.** It states
the exact paths to remove, the exact exports to strip from the five files both systems share, the
config keys to drop, the docs to rewrite, and a four-step order in which `npm run verify` stays green
at every commit. The deletion is not housekeeping: it turns the daily system's headline safety
property — *this repo cannot place an order* — from a convention into a structural fact (§2.1 E9,
§3 P1).

---

## 0. How to read this document

- **§1** goal and what "done" means. **§2** the audit: what is actually true about the two systems
  today, with `file:line` evidence for every claim (L-006).
- **§3** design principles — the invariants every later section is checked against, including the
  fail-closed default for a deletion (L-008).
- **§4** the decision (delete vs keep-dormant vs archive branch) and why.
- **§5** the contract: the exact, complete lists. This is what an implementer copies.
- **§6** acceptance criteria — each one an observable command with an expected result (L-001).
- **§7** error & edge behavior for the transition (fail-closed table).
- **§8** the phased plan, with the go/no-go sentence (L-007).
- **§9** verification gates. **§10** constraints. **§11** out of scope (L-002).
- **§12** assumptions for owner veto. **§13** considered alternatives, deferred (L-010).

Severity tiers (same scheme as `specs/daily-catalyst-manual-trading.md:72-77`):

- **P0 — blocks the deletion.** Without it, the deletion either breaks the daily system or leaves a
  live order-placing path behind. These are the correctness conditions of the change itself.
- **P1 — blocks calling Phase 8 done.** The repo would still describe a product it no longer is.
- **P2 — hardening.** Worth doing, not blocking.
- **P3 — improvement.** Cosmetic or deferrable.

**What "the scalper" means in this document:** the 5-minute auto-trading loop rooted at
`src/main.ts` (`setInterval` → `runTradingCycle()`, `src/main.ts:626`, `:633`, `:190`), the
indicator/signal/risk engine under `src/strategy/`, the Bybit order-placing connector
(`src/bybit/connector.ts`), the paper executor and portfolio, the learning journal/analyzer, the
SSE dashboard on port 3081 (`src/server/index.ts` + `public/index.html`), and the offline research
harness that trained and validated it (`scripts/train-model.ts`, `walk-forward.ts`, `backtest.ts`,
`fetch-klines.ts`, `export-folds.ts`, `crosscheck-export.ts`, `barrier-sweep.ts`, `exit-mix.ts`,
`auc_feasibility.py`, `crosscheck/`).

**What "the daily system" means:** everything `specs/daily-catalyst-manual-trading.md` built —
`src/research/`, `src/journal/`, `src/backtest-daily/`, `src/decision/`,
`src/server/journal-server.ts` + `src/server/public/journal.html`,
`scripts/{snapshot-daily,research-daily,backfill-history,backtest-daily,farside-import,decide-daily}.ts`,
`prompts/`, `.claude/skills/crypto-fundamental-analyst/`, `research-rules.json`.

---

## 1. Goal

**Remove the 5-minute auto-trader and its research harness from the working tree, leaving a
repository that contains exactly one trading system — the daily catalyst, manual-execution system —
whose `npm run verify` is green, whose test suite contains no test of deleted code, and in which no
module can place, amend or cancel an order or change leverage or margin mode.** The deletion is
staged in four commits (§8) so that `npm run typecheck` and `npm test` pass after each one; nothing
the daily system imports is removed; and everything deleted stays recoverable from git history at
`65988db` without an archive branch (§4, §13).

The deliverable of *this* document is the decision plus the exact plan. Implementation follows
acceptance.

---

## 2. Audit of the current system

### 2.1 Repository facts that drive the decision

| # | Fact | Evidence |
|---|------|----------|
| E1 | The scalper's out-of-sample edge is confirmed negative: median −0.1767%/day, 15/47 folds positive, p = 0.9960, all 5 symbols lose. Nothing on free 5m data reaches the AUC needed to break even. | `specs/daily-catalyst-manual-trading.md:129-130` (E1/E2); artifacts `data/validation/walk-forward-2026-09-08.json`, `data/validation/auc-feasibility-2026-09-08.json` |
| E2 | The daily system's own spec already records the scalper as unused and slated for retirement, and defers this decision to a separate spec. | `specs/daily-catalyst-manual-trading.md:2220` (Phase 8 row), `:2388-2395` (A33), `:2283` (out of scope) |
| E3 | **The entire scalper cluster hangs off the daily system by exactly one import edge.** `src/backtest-daily/stats.ts:11` does `import { percentile } from "../strategy/walkforward.ts"`. That single line is the only reason `src/strategy/` (13 files), `src/executor.ts`, `src/market.ts`, `src/portfolio.ts` and their whole transitive closure are reachable from a daily entrypoint. | `src/backtest-daily/stats.ts:11`; reachability computed from the six daily CLI entrypoints + `src/server/journal-server.ts` over every relative `import`/`import()` in `src/` and `scripts/` |
| E4 | `percentile` is a 5-line pure numeric helper with no imports, and the repo **already contains a copy of it** under another name: `scripts/exit-mix.ts:74`'s local `quantile` has a line-for-line identical body — same empty guard returning `0`, same `[...xs].sort((a, b) => a - b)`, same `s[Math.min(s.length - 1, Math.floor(s.length * q))]` clamped nearest-rank — differing only in the wrapper (`const quantile = (xs, q) =>` vs `export function percentile(xs, q): number`). Relocating it is therefore a copy of a helper the repo has already copied once: a mechanical move, not a refactor. | `src/strategy/walkforward.ts:109-113`; duplicate body at `scripts/exit-mix.ts:74-78` |
| E5 | Its two siblings in the same file have **no consumer outside the delete set**, so only `percentile` needs to survive. Verified symbol by symbol: `binomialUpperTail` (`:120`) has **zero** references anywhere in `src/`, `scripts/` or `tests/` except its own definition and `tests/walkforward.test.ts`. `median` (`:101`) is imported by `tests/walkforward.test.ts` and by nothing else; every other `median` hit in the repo is either a different symbol (`report.medianDailyReturnPercent`, `report.medianAuc`), prose inside a log string, Python's `statistics.median`, or — at `scripts/exit-mix.ts:68` — a **locally defined arrow function**, not an import. `scripts/exit-mix.ts` imports nothing at all from `walkforward.ts`: its three `src/strategy/` imports are `bars.ts` (`:21`), `model.ts` (`:22`) and `backtest.ts` (`:23`). | complete import list: `rg -c 'from "[^"]*walkforward\.ts"' src scripts tests` → exactly **7 files, 8 import statements** (`src/backtest-daily/stats.ts:11` `percentile`; `tests/backtest-stats.test.ts:9` `percentile`; `tests/walkforward.test.ts:15-16` all seven exports; `scripts/barrier-sweep.ts:32` + `:33`; `scripts/walk-forward.ts:15`; `scripts/export-folds.ts:31`; `scripts/crosscheck-export.ts:38`) — **`scripts/exit-mix.ts` is absent, and `rg -c "walkforward" scripts/exit-mix.ts` returns no hit at all**. `binomialUpperTail` absence: `rg -n "binomialUpperTail" src scripts tests \| rg -v "^(src/strategy/walkforward\.ts\|tests/walkforward\.test\.ts)"` → empty. Local definitions in exit-mix: `:68-73` (`median`), `:74-78` (`quantile`); its only `src/strategy/` imports are `:21` `bars.ts`, `:22` `model.ts`, `:23` `backtest.ts` |
| E5a | Across all seven importing files, exactly **two import sites** reach `walkforward.ts` from outside the delete set, and both ask for the same symbol — `percentile`: `src/backtest-daily/stats.ts:11` (daily code, E3) and `tests/backtest-stats.test.ts:9` (a daily test). Every other export — `DAY_MS`, `WalkForwardError`, `buildFolds`, `runWalkForward`, the `Fold`/`FoldResult`/`WalkForwardReport` types, `median`, `binomialUpperTail` — is consumed only by `tests/walkforward.test.ts` and four delete-set scripts. So §5.9 has to move one symbol, and §5.1 can delete the file. | the same 7-file import list above; outside-consumers `scripts/{barrier-sweep,walk-forward}.ts` (`runWalkForward`, `WalkForwardReport`), `scripts/{export-folds,crosscheck-export}.ts` (`buildFolds`, `DAY_MS`) — all four in §5.1 |
| E6 | The other four shared files are shared for real, and all four are read-only or pure: `src/config.ts`, `src/bybit/adapters.ts`, `src/bybit/rest.ts` (+ `rate-limiter.ts`, `types.ts` beneath it) and `src/risk/circuit-breaker.ts`. | `src/server/journal-server.ts:16-19`, `:41`; `src/journal/exchange-sync.ts:25-26`; `src/journal/breaker.ts:14-17`; `src/research/sources/{bybit-funding,bybit-instruments,bybit-klines,bybit-oi}.ts` (all import `appSymbolToBybit`); `scripts/backfill-history.ts:18`, `:22` |
| E7 | The daily system uses **two** of `adapters.ts`'s seven exports. The other five (`tickerToMarketSnapshot`, `orderResponseToTradeResult`, `bybitPositionToPosition`, `walletToTotalUsd`, `walletAvailableBalance`) are called only from `src/bybit/connector.ts`, `src/main.ts` and `tests/bybit.test.ts`. | callers: `src/bybit/connector.ts:12`, `:232`, `:756`, `:864`, `:940`, `:957`, `:972`; `src/main.ts:584`; `tests/bybit.test.ts:9-15` |
| E8 | Those five exports are the **only** reason `adapters.ts` imports `../market.ts`, `../executor.ts` and `../portfolio.ts`. Without trimming them, deleting those three modules breaks `tsc`. After trimming, `adapters.ts` has zero imports. | `src/bybit/adapters.ts:3-7` |
| E9 | **Four order-mutating methods survive in a file the daily system keeps.** `src/bybit/rest.ts` exposes `placeOrder` (`:175`), `cancelOrder` (`:219`), `setLeverage` (`:288`) and `setMarginMode` (`:299`) on the same `RestClient` the journal server constructs (`src/server/journal-server.ts:609-614`). The daily system calls exactly four read methods on it: `getApiKeyInfo`, `getExecutions`, `getFundingExecutions`, `getPositions`. | `src/bybit/rest.ts:175`, `:219`, `:288`, `:299`; `src/journal/exchange-sync.ts:50`, `:322`, `:368`, `:454`; no other daily call site in `rg -n "\.placeOrder\|\.cancelOrder\|\.setLeverage\|\.setMarginMode" src scripts` |
| E10 | Today, P4 ("read-only by construction") is enforced only by a runtime key check plus the *absence* of a call, not by the absence of the capability. The only current caller of `placeOrder` is the scalper. | guard: `src/journal/exchange-sync.ts:47` (`assertReadOnlyKey`); sole caller: `src/main.ts:399` → `src/bybit/connector.ts:664`, `:531`, `:745` |
| E11 | `loadConfig` **allow-lists** known keys out of the parsed JSON and never rejects an unknown one: it reads `raw["<key>"]` field by field and returns only what it recognized. An existing `config.json` that still carries retired keys therefore keeps loading unchanged after they are dropped. | `src/config.ts:316-352` (the field-by-field `raw[...]` block), `:358-366` (the three conditional blocks), `:369-530` (validation reaches only assigned fields) |
| E12 | 25 of `Config`'s 38 keys are never read by any daily module. | per-key scan of `src/`, `scripts/`, excluding `src/config.ts`: see §5.6's table |
| E13 | One `loadConfig` test asserts an exhaustive round-trip against a raw fixture and is documented as a guard against silently dropping a field — dropping keys **must** update it in the same commit. | `src/config.ts:353-357` (the comment naming the test), `tests/config.test.ts:177` |
| E14 | **284 of the repo's 833 tests (34%) test only deleted code**, spread over 23 of 63 test files. `npm test` is green today: `tests 833 / pass 833 / fail 0`. | measured this session: full run `npm test` → 833/833 in 10 760 ms; the 23-file delete set run alone → `tests 284 / pass 284 / fail 0` |
| E15 | Those 284 tests cost roughly 9.9 s of the suite's 10.8 s, almost all of it in the WebSocket and connector timer tests. Deleting them takes `npm test` from ~10.8 s to ~1 s. | measured: 14 files (incl. `ws-client`, `connector`) → 9 697 ms; the other 8 mixed files → 205 ms; full suite → 10 761 ms |
| E16 | Two test files reach their subject by a **dynamic, cache-busted import**, so a plain `^import` grep does not find them. Both target delete-set modules. | `tests/pending-orders.test.ts:8` (`import(\`../src/bybit/pending-orders.ts?t=...\`)`), `tests/journal-durability.test.ts:17` (`import(\`../src/learning/journal.ts?t=...\`)`) |
| E17 | The eight scalper harness scripts have **no `package.json` entry** — they are invoked by path. Only `start` and `dashboard` point at scalper code. | `package.json:10-11` (`start`, `dashboard` → `src/main.ts`); `package.json:12-18` (every other script → daily code) |
| E18 | `config.template.json` contains **only** scalper keys and none of the daily system's. A fresh checkout following it cannot configure the daily system. | `config.template.json:2-12` (`maxPositionSizeUsd`, `maxDailyTrades`, `stopLossPercent`, `takeProfitPercent`, `refreshIntervalMs`, `autoSelectSymbols`; no `manual`, `ai` or `persona`) |
| E19 | **The docs already lie.** `src/learning/optimizer.ts` does not exist in the repo, yet eight doc locations describe it as a live component of "Pillar 2". | `git ls-files 'src/learning/*'` → `analyzer.ts`, `journal.ts` only; claims at `docs/ARCHITECTURE.md:214`, `:420`, `:449`, `:462`; `docs/STRATEGY.md:4`, `:151`; `docs/USER_GUIDE.md:89`; `README.md:64`; `AGENTS.md:153` |
| E20 | `README.md` and `AGENTS.md` still declare the scalper to be the product identity, and `README.md`'s quick-start is `npm run dashboard` / `npm run start`. | `README.md:1-4`, `:24` ("81 tests" — also stale, E14), `:27`, `:31`, `:50-76`; `AGENTS.md:11-15` (§1 Identity), `:147-157` (§6.1 Three Pillars), `:159-165` (§6.2 Main Loop), `:167-173` (§6.3), `:269-278` (§11 commands) |
| E21 | Four whole docs are scalper-only end to end. | `docs/ARCHITECTURE.md` (469 lines, "The Three Pillars"), `docs/STRATEGY.md` (226), `docs/USER_GUIDE.md` (297, the port-3081 dashboard FAQ), `docs/RISK_MANAGEMENT.md` (143, Kelly sizing + "Hit Ctrl+C") |
| E22 | `data/validation/` holds 54 MB in four walk-forward artifacts — and those artifacts **are the evidence** for E1, cited by the daily spec's own evidence table. | `du -sh data/validation/*`: `walk-forward-2026-09-08.json` 14 M, `walk-forward-5m-...` 14 M, `walk-forward-maker-exits-...` 14 M, `walk-forward-zerofee-...` 13 M; cited at `specs/daily-catalyst-manual-trading.md:129-130` |
| E23 | `tests/fixtures/apt-usdt-session-2026-09-07.json` is the measured provenance of a **live daily** default: the 0.055%/side taker rate behind `manual.roundTripFeePercent = 0.11`. It is loaded by **no code at all, already today** — every reference to it is a comment or a spec citation — and the comment that records its role sits on a key this spec retires. | no loader: `rg -n "apt-usdt-session" src scripts tests` → only `tests/indicators.test.ts:89` (a comment) and `src/config.ts:78` (a comment); provenance note `src/config.ts:77-83`, attached to `estimatedRoundTripFeePercent`; surviving consumer `ManualTradingConfig.roundTripFeePercent` at `src/config.ts:231`, `:247`; also cited 5× in `specs/strategy-signal-quality.md` |
| E24 | `tests/fixtures/aptusdt-klines-15m.json`, by contrast, is used only by two delete-set tests. | `tests/backtest.test.ts`, `tests/fill-model.test.ts` |
| E25 | `crosscheck/` is a Freqtrade replay harness for the **scalper's** strategy, paired with `scripts/crosscheck-export.ts`. Nothing in the daily system references it. | `crosscheck/user_data/strategies/CrossCheckReplay.py`, `crosscheck/{compare,prepare}.py`, `crosscheck/freqtrade-config.json`, `crosscheck/README.md`; `.gitignore:40-46` |
| E26 | `.claude/launch.json` does **not** exist, and no systemd unit is tracked in the repo. Nothing in-repo points a scheduler at `src/main.ts`. | `git ls-files .claude` → only `skills/crypto-fundamental-analyst/**` |
| E27 | `specs/crypto-trader.md` — named in the Phase 8 brief — does **not** exist in this repository. The scalper-era specs that do exist are `profit-target-roadmap.md` (1325 lines), `strategy-signal-quality.md` (575) and `live-trading-readiness.md` (766). | `git ls-files specs/` |
| E28 | The delete set is 43 tracked files and 9 184 lines under `src/`, `scripts/` and `crosscheck/`, out of 22 181 lines across `src/` + `scripts/`. | `git ls-files <delete set> \| xargs wc -l` → 9 184; `git ls-files 'src/*' 'scripts/*' \| xargs wc -l` → 22 181 |

### 2.2 Findings

Every finding below is a consequence of §2.1, tiered by whether it blocks the deletion (P0), blocks
calling Phase 8 done (P1), or is hardening (P2/P3).

#### F1 (P0) — One import edge is load-bearing, and it is trivial

`src/backtest-daily/stats.ts:11` imports `percentile` from `src/strategy/walkforward.ts` (E3). Delete
`src/strategy/` without acting on that line and `tsc --noEmit` fails immediately, and with it
`npm run verify`. The mechanism is nothing more than a five-line quantile helper that was convenient
to reuse (E4), and neither of its two siblings is needed (E5).

**Recommendation:** move `percentile` verbatim into `src/backtest-daily/stats.ts` as an exported
function and repoint the one test that imports it (`tests/backtest-stats.test.ts:76`). Do this
**first**, in step 8a, before anything is deleted — see §5.9.

#### F2 (P0) — `adapters.ts` must be trimmed *before* `market/executor/portfolio` are deleted

`src/bybit/adapters.ts:3-5` type-imports `MarketSnapshot`, `TradeResult` and `Position` purely to type
five exports the daily system never calls (E7, E8). Deleting `src/market.ts`, `src/executor.ts` and
`src/portfolio.ts` while those exports remain is a typecheck failure in a file the daily system
depends on from six places (E6).

**Recommendation:** strip the five exports and the four now-unused imports in the same commit that
deletes their consumers (step 8b, §5.3). After the trim, `adapters.ts` imports nothing and exports
only `appSymbolToBybit` and `bybitSymbolToApp`.

#### F3 (P0) — The repo keeps a live order-placing capability inside the daily system's own REST client

This is the finding that makes Phase 8 worth doing on safety grounds rather than tidiness grounds.
`src/bybit/rest.ts` is a file the daily system keeps and instantiates with real mainnet credentials
(`src/server/journal-server.ts:609-614`), and it exposes `placeOrder`, `cancelOrder`, `setLeverage`
and `setMarginMode` (E9). Today the only thing stopping an order is that nothing in the daily code
path calls them, plus `assertReadOnlyKey`'s runtime refusal (E10).

Concrete mechanism: a future change to the journal server — an "close this position" button, a
convenience helper, an LLM-authored patch that reaches for the nearest method with the right name —
is one line away from placing a real order, and nothing structural stops it. `assertReadOnlyKey`
catches the *key*, not the *call*: it runs once at server start against
`BYBIT_READONLY_API_KEY`/`BYBIT_READONLY_API_SECRET`, and a `RestClient` constructed anywhere else
with a trade-enabled key is unguarded.

**Recommendation:** delete all four methods (§5.3) and the four order/position-mutating entries from
`ENDPOINT_LIMITS` (`src/bybit/types.ts:313-315`, `:320`). After that, `rg -n
"placeOrder|createOrder|cancelOrder|setLeverage|setMarginMode|amendOrder" src scripts` returns
nothing at all, and P4 is structural. The `bybit-official-ts-sdk` dependency stays, because
`rest.ts` still needs it for reads — see §12 A5 for the honest limit of the claim.

#### F4 (P0) — Two tests hide their subject behind a dynamic import

`tests/pending-orders.test.ts` and `tests/journal-durability.test.ts` reach `src/bybit/pending-orders.ts`
and `src/learning/journal.ts` through a cache-busted template-literal `import()` (E16). A deletion
driven by a static-import grep will leave them behind, and they fail at runtime with a module-not-found
error *after* the delete commit — the worst place to discover it, since `npm test` was the gate.

**Recommendation:** both files are in §5.4's delete list, and §9 gate 5 greps for
`import(\`../src/` across `tests/` so the class of mistake cannot recur.

#### F5 (P0) — 34% of the test suite tests code that is going away

833 tests today; 284 of them, across 23 files, exercise only delete-set modules (E14). Leaving any of
them in place breaks `npm test`; deleting them without stating the expected new total leaves the gate
unfalsifiable ("all green" is true of a suite that silently lost a hundred tests to a bad glob — the
exact failure L-004 was written for).

**Recommendation:** §5.4 lists all 23 files with their test counts and §6 states the exact expected
totals after each step: 549 after 8b, 521 after 8c.

#### F6 (P1) — 25 config keys become dead, and `loadConfig` *requires* five of them

`Config` has 38 keys; 25 are read by no daily module (E12). Five of those 25 are currently
**mandatory** — `maxPositionSizeUsd`, `maxDailyTrades`, `stopLossPercent`, `takeProfitPercent`,
`refreshIntervalMs` all throw `ConfigError` when absent (`src/config.ts:384-401`) — so the daily
system today refuses to start without five numbers that only the scalper ever reads. And
`config.template.json` documents only the scalper's keys and none of the daily system's (E18).

The migration question ("does dropping a key break an existing `config.json` that still has it?")
has a definitive answer in the code, not a design choice: **no**. `loadConfig` allow-lists known
keys field by field and never validates the shape of `raw` as a whole (E11), so a retired key in a
real `config.json` is simply ignored from the moment its line is removed from `src/config.ts`.

**Recommendation:** drop all 25 (§5.6), keep the "ignore unknown keys" behavior exactly as it is
(§12 A2 records this for veto — the alternative, adding unknown-key rejection, would *create* the
breakage this change otherwise doesn't have), rewrite `config.template.json` around the surviving
keys plus `manual`/`ai`/`persona`, and update `tests/config.test.ts`'s exhaustive round-trip in the
same commit (E13).

#### F7 (P1) — The repo's identity documents describe a product that will not exist

`README.md:1-4` calls the repo an "Expert Trading Engine" with a learning system and a real-time
dashboard; its quick start is `npm run dashboard`; its project-structure block lists `src/strategy/`,
`src/learning/`, `src/market.ts`, `src/executor.ts`, `src/tui.ts` and a file that does not exist
(E19, E20). `AGENTS.md` §1 defines the repo's identity the same way and §6.1 hands every future agent
a "Three Pillars" architecture, §6.2 a 5-minute main loop, §6.3 an order-placement flow — the exact
mental model Phase 8 removes. Four whole docs are scalper-only (E21).

Mechanism of harm, and it is not cosmetic: `AGENTS.md` is the file this repo hands to every AI agent
as its contract. An agent that reads §6.3 step 5 ("On order signal: calculate qty → place REST
order") after Phase 8 will look for the order path, and F3's trimmed `rest.ts` is what keeps that
search from succeeding. Stale identity docs plus a live capability is the dangerous combination; this
spec removes both halves.

**Recommendation:** §5.8. Delete the four scalper-only docs, rewrite `README.md` and `AGENTS.md`
§1/§4/§6/§10/§11 around the daily system, rewrite `docs/SETUP.md` and `docs/BYBIT_INTEGRATION.md`
(their install and read-only-key/rate-limit content is still true and still needed), and correct
`docs/DAILY_WORKFLOW.md:549-551`, whose A33 paragraph explains a side effect on an auto-trader that
will no longer exist.

#### F8 (P1) — Three scalper-era specs will describe deleted code without saying so

`specs/profit-target-roadmap.md` (49 scalper references), `specs/strategy-signal-quality.md` (11) and
`specs/live-trading-readiness.md` (7) are the design record of the deleted engine (E27). They are also
the *reason* the deletion is justified: `profit-target-roadmap.md:3-7` is where E1's numbers live, and
the daily spec cites it directly.

**Recommendation:** keep the files, add a four-line superseded header to each (§5.8.3). Do not move or
rewrite them: a spec whose path changes breaks every `file:line` citation pointing at it, including
`specs/daily-catalyst-manual-trading.md:72`, `:129`, `:2293` and `:113`.

#### F9 (P2) — The evidence for the deletion is 54 MB, and deleting it is self-defeating

`data/validation/`'s four walk-forward artifacts are 54 MB (E22). They are also the only artifact-level
proof of E1 — the finding this entire spec rests on, and the one the daily spec's evidence table cites
by filename. Deleting the proof that the scalper had no edge, in the commit that deletes the scalper,
is precisely the mistake L-006 exists to prevent.

**Recommendation:** **keep all eight `data/validation/*.json` files.** Delete only
`data/model/scalping-model.json` (4 KB — trained weights for a deleted model, cited by nothing as
evidence of a conclusion). The 54 MB is the price of a falsifiable record. §12 A4 records this for
veto and §13 names the alternative that would reclaim the space honestly.

#### F10 (P2) — One shared fixture is evidence for a *live* daily default

`tests/fixtures/apt-usdt-session-2026-09-07.json` is the measured source of the 0.055%/side taker rate
(E23). A delete pass driven by "which tests load this fixture?" would remove it, because the answer is
**none** — and has been none since before this spec: `tests/indicators.test.ts:89` and `src/config.ts:78`
only *name* it in comments. But the number it measures is live in `ManualTradingConfig.roundTripFeePercent`
(default 0.11), which the planner uses on every real daily plan, and the comment recording that provenance
is attached to `estimatedRoundTripFeePercent` — a key §5.6 retires. Delete the fixture, or the comment, and
the daily system's fee default becomes an unsourced 0.11.

**Recommendation:** keep the fixture; move the provenance comment from `src/config.ts:77-83` onto
`ManualTradingConfig.roundTripFeePercent` (`src/config.ts:231`) in step 8c. Delete
`tests/fixtures/aptusdt-klines-15m.json`, which has no such role (E24).

#### F11 (P3) — `.gitignore` will carry rules for paths that cannot exist

`.gitignore:14`, `:17-22`, `:28-34`, `:40-46`, `:51-52` ignore `learning-insights.json`,
`trade-journal.json*`, `pending-orders.json*`, `data/klines/`, `data/klines-365/`, `crosscheck/**` and
`data/validation/folds/` — all of them outputs of deleted code (E25).

**Recommendation:** trim them in step 8d (§5.7). Harmless if skipped; noise if kept.

---

## 3. Design principles for the deletion

Every section from §4 onward is checked against these.

- **P1 — Deleting a capability is the point, not a side effect.** The change is judged by what the
  repo can no longer do. After it, no module under `src/` or `scripts/` can place, amend or cancel an
  order, or change leverage or margin mode (F3). `src/journal/exchange-sync.ts:47`'s runtime
  `assertReadOnlyKey` stays as defence in depth; it is no longer the only defence.
- **P2 — Fail closed on ambiguity: keep, don't guess.** (L-008.) For any path where this spec cannot
  demonstrate from evidence that the daily system does not need it, the default is **keep it**, list
  it in §5.2, and record the uncertainty in §12 — never "delete and see if the tests go red". The
  irreversible action here is deletion; a false delete costs a revert plus whatever shipped in
  between, a false keep costs a dead file. The asymmetry decides every borderline case below
  (`syncTime`, `getKline`, `data/validation/`, `apt-usdt-session`).
- **P3 — Green at every commit, not just at the end.** Each step in §8 is a commit after which
  `npm run typecheck` and `npm test` both pass. No step leaves the tree in a state where the gate is
  expected to fail. This is what forces the order 8a → 8b → 8c → 8d (relocate, then delete, then
  trim, then document): a trim before its consumer is deleted is a red typecheck, and a delete before
  the relocation is a red typecheck too.
- **P4 — Git history is the archive.** Everything deleted is recoverable at `65988db`
  (`git show 65988db:src/main.ts`, `git log --diff-filter=D`). No archive branch, no `legacy/`
  directory, no commented-out code (§4, §13). A deletion that leaves a copy behind has not reduced
  the surface it claimed to reduce.
- **P5 — The daily system gains nothing.** This spec adds exactly one symbol to the daily system
  (`percentile` in `stats.ts`) and removes 25 config keys and nine exports. It introduces no new
  behavior, no new dependency, no new file besides itself, and it must not become the vehicle for a
  daily-system feature (§11).
- **P6 — Every claim of "unused" cites where it is used from.** (L-006.) §5's delete list is
  reachability-derived, not eyeballed; the trim lists in §5.3 name every remaining caller.
- **P7 — The docs must describe the repo that exists.** A repo whose `AGENTS.md` describes an
  order-placing main loop it no longer has is worse than one that never had the doc: it sends the next
  agent looking for the capability. §8d is a required phase, not a follow-up (F7).

---

## 4. The decision

**Delete.** Not keep-dormant, not archive-branch.

The owner's stated intent is deletion, and this spec found no dependency that argues against it. The
supporting evidence, in the order it mattered:

1. **There is no real coupling to break** (F1). The whole 29-file `src/` cluster hangs off one import
   of a five-line quantile helper (E3, E4). Every other shared file is shared for a read-only or pure
   reason and stays (E6). A retirement that looked like it would need an architectural seam needs a
   one-function move.
2. **Deletion buys a structural safety property that dormancy cannot** (F3). A dormant `src/main.ts`
   keeps `BybitConnector.placeOrder` and `RestClient.placeOrder` compiled, tested and one call away
   from a real order, in a repository whose headline principle is that it cannot place orders. Keeping
   the engine "in case" keeps exactly the thing the daily system's P4 promises is absent.
3. **The code has a confirmed negative edge and no user** (E1, E2). There is nothing to preserve
   optionality *for*. The measured result is not "unproven"; it is "loses, p = 0.9960".
4. **It is a third of the test suite and 90% of its runtime** (E14, E15). `npm test` goes from ~10.8 s
   to ~1 s, which is the difference between a gate you run on every edit and one you batch.
5. **The docs are already wrong in a way that is only fixable by choosing** (E19, F7). Eight places
   describe a `src/learning/optimizer.ts` that does not exist. Documentation cannot be made honest
   about two systems when one of them is a half-deleted ghost; it can be made honest about one.

**Why not keep-dormant** (delete `package.json`'s `start`/`dashboard`, leave the modules): it keeps
every cost — the 284 tests, the 25 config keys, the stale docs, the order-placing methods — and buys
only the ability to `git revert` less, which P4 already provides. It also creates a category the repo
has no rule for: compiled, typechecked, tested code that is nobody's product. That category rots.

**Why not an archive branch** (`legacy/scalper-5m` pushed before deleting): git already preserves
every byte at `65988db`, reachable by tag, SHA, or `git log --diff-filter=D -- src/main.ts` (P4). A
branch adds a second thing to remember, invites "just fix it on the archive branch", and would need
its own answer to F3 (an archive branch that still compiles still contains `placeOrder`). If the owner
wants a stable label rather than a SHA, the proportionate form is an annotated tag on `65988db`
(§13) — it costs one command and no ongoing surface.

**What would have changed the decision:** a daily module importing `src/strategy/signals.ts`,
`src/executor.ts` or `src/learning/journal.ts` for anything but a pure helper; a passing Gate D0/D1
artifact for any 5m rule; a scheduler in the repo pointing at `src/main.ts` (E26 — there is none). None
of these hold.

---

## 5. Contract

The complete, exact lists. §5.1–5.4 are what step 8a/8b execute; §5.5–5.8 are steps 8c/8d.

**Totals.** Deleted: 43 tracked files under `src/`+`scripts/`+`crosscheck/` (9 184 lines of 22 181,
E28) + 23 test files (284 of 833 tests) + 1 test fixture + 1 `data/` file + 4 docs = **72 files**.
Trimmed: **5 source files** (`src/config.ts`, `src/bybit/{adapters,rest,types}.ts`,
`src/risk/circuit-breaker.ts`) + **4 test files** (28 tests). Incidentally edited: **2 files**
(`src/server/journal-server.ts:613`, `tests/backtest-stats.test.ts`'s import). Added: **1 symbol**
(`percentile` into `src/backtest-daily/stats.ts`). Rewritten: **6 files** (`README.md`, `AGENTS.md`,
`docs/SETUP.md`, `docs/BYBIT_INTEGRATION.md`, `docs/DAILY_WORKFLOW.md:549-551`,
`config.template.json`). Header-only: **3 superseded specs** + 2 line edits in
`specs/daily-catalyst-manual-trading.md`. Plus `package.json` and `.gitignore`.

### 5.1 Delete — `src/` (29 files)

Reachable only from `src/main.ts` (or from a delete-set script), never from a daily entrypoint.

| Path | Lines | Why it is scalper-only |
|------|-------|------------------------|
| `src/main.ts` | 1005 | the 5m loop itself (`:626` `setInterval`, `:633` `runTradingCycle`, `:399` `placeOrder`) |
| `src/tui.ts` | 65 | terminal UI for that loop; imports `market.ts`, `portfolio.ts`, `strategy/signals.ts` |
| `src/logger.ts` | — | session logger, imported only by `src/main.ts` |
| `src/instance-lock.ts` | — | single-instance lock for the loop; imported only by `src/main.ts` |
| `src/startup-safety.ts` | — | `--live` capital warning (`maxCapitalUsdWarnThreshold`); only `src/main.ts` |
| `src/executor.ts` | — | paper trade executor; only reached from `main.ts`, `strategy/`, `portfolio.ts`, `learning/journal.ts`, and (after §5.3) nothing |
| `src/market.ts` | — | simulated market feed |
| `src/portfolio.ts` | — | cash-guardrail portfolio |
| `src/server/index.ts` | — | the port-3081 SSE dashboard server; imported **only** by `src/main.ts` |
| `src/server/public/index.html` | 520 | that dashboard's UI; served only by `src/server/index.ts:93` |
| `src/bybit/connector.ts` | 982 | REST+WS connector; the order-placing path (`:531`, `:664`, `:745`), `setLeverage` (`:403`), `setMarginMode` (`:390`) |
| `src/bybit/ws.ts` | 289 | Bybit WebSocket client; only `connector.ts` |
| `src/bybit/pending-orders.ts` | — | crash-recovery record for in-flight orders; only `connector.ts` (+ `tests/pending-orders.test.ts`, E16) |
| `src/risk/wallet-monitor.ts` | — | live wallet vs. portfolio reconciliation for the loop; only `src/main.ts` |
| `src/learning/journal.ts` | — | the scalping trade journal (`indicatorsAtEntry: { rsi; momentum; atr }`) |
| `src/learning/analyzer.ts` | — | its performance analyzer; only `main.ts` and `server/index.ts` |
| `src/strategy/backtest.ts` | 328 | 5m backtester |
| `src/strategy/bars.ts` | — | dollar bars |
| `src/strategy/candles.ts` | — | `DEFAULT_INTERVAL_MS = 5 * 60_000` (`:15`) — the 5-minute assumption in code |
| `src/strategy/concentration.ts` | — | correlation / max-concurrent-position caps |
| `src/strategy/exit-reason.ts` | — | exit classification for the loop |
| `src/strategy/features.ts` | — | 5m feature extraction |
| `src/strategy/indicators.ts` | — | RSI/MACD/Bollinger/SMA/ATR/momentum |
| `src/strategy/model.ts` | — | trained entry model (`DEFAULT_MODEL_PATH` → `data/model/scalping-model.json`) |
| `src/strategy/risk.ts` | — | Kelly sizing / ATR stops |
| `src/strategy/signals.ts` | 515 | multi-indicator scoring + decision logic |
| `src/strategy/symbol-recommender.ts` | — | auto symbol selection (`autoSelectSymbols`) |
| `src/strategy/training.ts` | — | model training |
| `src/strategy/walkforward.ts` | 478 | walk-forward harness — **after** §5.9 moves `percentile` out |

Both `src/learning/` and `src/strategy/` become empty and the directories go with them. `src/risk/`
keeps `circuit-breaker.ts`; `src/bybit/` keeps `adapters.ts`, `rest.ts`, `rate-limiter.ts`, `types.ts`;
`src/server/` keeps `journal-server.ts` and `public/journal.html`.

### 5.2 Keep — shared files the daily system needs (6 files)

Listed explicitly so "it compiled" is not the only reason any of them survived (P2, P6).

| Path | Kept because | Daily callers |
|------|--------------|---------------|
| `src/config.ts` | `loadConfig`, `resolveManualTradingConfig`, `resolvePersonaConfig`, `resolveAiAnalystConfig`, `ConfigError` | `src/server/journal-server.ts:16-17`, `src/decision/{decide,types}.ts`, and all six daily scripts |
| `src/bybit/adapters.ts` | `appSymbolToBybit`, `bybitSymbolToApp` | `src/journal/{market-data,exchange-sync}.ts`, `src/server/journal-server.ts:19`, `src/research/sources/bybit-{funding,instruments,klines,oi}.ts`, `scripts/backfill-history.ts:22` — **trimmed**, §5.3 |
| `src/bybit/rest.ts` | `RestClient` reads: `getApiKeyInfo`, `getExecutions`, `getFundingExecutions`, `getPositions` | `src/server/journal-server.ts:18`, `src/journal/exchange-sync.ts:26,50,322,368,454` — **trimmed**, §5.3 |
| `src/bybit/rate-limiter.ts` | `EndpointRateLimiter` (token buckets) | `src/bybit/rest.ts:20`, `src/research/sources/bybit-shared.ts` — **no change** |
| `src/bybit/types.ts` | `BybitConfig`, `BYBIT_HOSTS`, `BybitApiResponse`, `classifyError` + the six error classes it constructs, `ENDPOINT_LIMITS`/`getEndpointLimit` | `src/bybit/{rest,rate-limiter,adapters}.ts` — **trimmed**, §5.3 |
| `src/risk/circuit-breaker.ts` | `DEFAULT_CIRCUIT_BREAKER_CONFIG`, `CircuitBreakerConfig`, `CircuitBreakerTrigger`, `createCircuitBreakerState`, `checkEquityBreakers`, `recordTradeOutcome`, `checkConsecutiveLosses` | `src/journal/breaker.ts:14-17`, `src/server/journal-server.ts:41`, `scripts/{decide-daily,research-daily}.ts:35` — **trimmed**, §5.3 |

### 5.3 Trim — shared files with scalper-only exports (5 files)

Each row: remove these, keep those, with the line where each lives today.

**`src/bybit/adapters.ts`** — required by F2, or `tsc` fails.

- **Remove:** `tickerToMarketSnapshot` (`:15`), `orderResponseToTradeResult` (`:58`),
  `bybitPositionToPosition` (`:88`), `walletToTotalUsd` (`:102`), `walletAvailableBalance` (`:109`).
- **Remove the imports they alone need:** `MarketSnapshot` (`:3`), `TradeResult` (`:4`), `Position`
  (`:5`), `BybitTicker`/`BybitOrderResponse`/`BybitPosition`/`BybitWalletBalance` (`:6`),
  `BybitFillUncertainError` (`:7`).
- **Keep:** `appSymbolToBybit` (`:117`), `bybitSymbolToApp` (`:124`).
- **Result:** a two-function module with zero imports.

**`src/bybit/rest.ts`** — required by F3 (P4 becomes structural).

- **Remove:** `placeOrder` (`:175`), `cancelOrder` (`:219`), `setLeverage` (`:288`),
  `setMarginMode` (`:299`).
- **Keep every read method**, including the four the daily system calls today
  (`getApiKeyInfo` `:311`, `getExecutions` `:326`, `getFundingExecutions` `:344`, `getPositions`
  `:240`) **and** the ones it does not (`syncTime` `:94`, `getTickers` `:121`, `getKline` `:128`,
  `getOrderbook` `:143`, `getInstruments` `:151`, `getRecentTrades` `:158`, `getOpenOrders` `:226`,
  `getOrderHistory` `:233`, `getWalletBalance` `:247`, `getFundingHistory` `:263`). Rationale under
  P2: they are read-only, they carry zero capability risk, and `getKline`/`getWalletBalance` are the
  obvious next reads a journal or chart feature wants. Trimming them is §13's deferred option, not
  this spec's.
- **Keep:** the constructor (`:38`), `RestClientOptions` (`:22`), the retry/rate-limit plumbing, the
  `bybit-official-ts-sdk` import (`:16`) — still needed for reads.

**`src/bybit/types.ts`**

- **Remove (WebSocket, deleted with `ws.ts`):** `BYBIT_WS_PUBLIC` (`:31`), `BYBIT_WS_PRIVATE` (`:36`),
  `WsTopic` (`:152`), `WsAuthMessage` (`:161`), `WsSubscribeMessage` (`:166`), `WsPingMessage` (`:171`).
- **Remove (order/position DTOs, no remaining producer):** `BybitTicker` (`:43`), `BybitKline` (`:61`),
  `BybitOrderbookEntry` (`:71`), `BybitOrderbook` (`:76`), `BybitOrderRequest` (`:84`),
  `BybitOrderStatus` (`:99`), `BybitOrderResponse` (`:103`), `BybitPosition` (`:127`),
  `BybitWalletBalance` (`:142`), `BybitFillUncertainError` (`:263`).
- **Remove from `ENDPOINT_LIMITS` (F3 consistency — no rate limit for a call that cannot be made):**
  `"/v5/order/create"` (`:313`), `"/v5/order/amend"` (`:314`), `"/v5/order/cancel"` (`:315`),
  `"/v5/position/set-leverage"` (`:320`).
- **Remove from `BybitConfig`:** `wsPingIntervalMs` (`:11`), `usePostOnlyEntries` (`:18`),
  `postOnlyTimeoutMs` (`:21`). `src/server/journal-server.ts:613` passes `wsPingIntervalMs: 20_000` and
  must drop it in the same commit; `maxRetries` stays.
- **Keep (all six error classes `classifyError` constructs, plus its callers'):** `BybitConfig` (`:6`),
  `BYBIT_HOSTS` (`:26`), `BybitApiResponse` (`:178`), `BybitApiError` (`:188`), `BybitAuthError` (`:200`),
  `BybitRateLimitError` (`:207`), `BybitInsufficientBalanceError` (`:214`), `BybitInvalidQtyError` (`:221`),
  `BybitConnectionError` (`:228`), `BybitConfigError` (`:235`), `BybitFatalError` (`:248`),
  `classifyError` (`:276`), `ENDPOINT_LIMITS` (`:308`), `getEndpointLimit` (`:325`).
  **Do not remove `BybitInsufficientBalanceError`, `BybitInvalidQtyError` or `BybitFatalError`** — they
  look order-specific but `classifyError` returns all three (`:284`, `:295`, `:299`) and `rest.ts:19`
  imports it.

**`src/risk/circuit-breaker.ts`**

- **Remove:** `checkSlippage` (`:148`) — sole caller `src/main.ts:487`; `src/journal/breaker.ts:14-16`
  imports the other four functions and never this one.
- **Keep:** `CircuitBreakerConfig` (`:17`) **including its `maxSlippagePercent` field** (`:26`),
  `DEFAULT_CIRCUIT_BREAKER_CONFIG` (`:29`), `CircuitBreakerState` (`:36`), `CircuitBreakerTrigger`
  (`:44`), `CircuitBreakerTrip` (`:46`), `createCircuitBreakerState` (`:59`), `checkEquityBreakers`
  (`:76`), `recordTradeOutcome` (`:122`), `checkConsecutiveLosses` (`:127`). The field stays because
  `src/journal/breaker.ts:24` does `interface BreakerConfig extends CircuitBreakerConfig` and both
  `src/server/journal-server.ts:172` and `scripts/decide-daily.ts:286` populate it from
  `DEFAULT_CIRCUIT_BREAKER_CONFIG.maxSlippagePercent`. Removing the field is a daily-system change and
  is out of scope (§11).

**`src/config.ts`** — see §5.6 for the 25 keys; the file itself stays.

### 5.4 Delete — tests (23 files, 284 tests) and 1 fixture

`npm test` today: **833 tests / 833 pass**. These 23 files contribute **284**, measured by running
them as a set.

Pure delete-set (15 files, 203 tests) — every module under test is in §5.1:

| File | Tests | Subject |
|------|------:|---------|
| `tests/connector.test.ts` | 72 | `src/bybit/connector.ts`, `src/bybit/pending-orders.ts` |
| `tests/ws-client.test.ts` | 32 | `src/bybit/ws.ts` |
| `tests/indicators.test.ts` | 17 | `src/strategy/indicators.ts` |
| `tests/walkforward.test.ts` | 15 | `src/strategy/{walkforward,training,backtest}.ts` |
| `tests/concentration.test.ts` | 11 | `src/strategy/concentration.ts` |
| `tests/symbol-recommender.test.ts` | 11 | `src/strategy/symbol-recommender.ts` |
| `tests/portfolio.test.ts` | 7 | `src/portfolio.ts`, `src/executor.ts` |
| `tests/wallet-monitor.test.ts` | 7 | `src/risk/wallet-monitor.ts` |
| `tests/instance-lock.test.ts` | 6 | `src/instance-lock.ts` |
| `tests/pending-orders.test.ts` | 6 | `src/bybit/pending-orders.ts` — **dynamic import**, `:8` (F4) |
| `tests/bars.test.ts` | 5 | `src/strategy/bars.ts` |
| `tests/journal.test.ts` | 5 | `src/learning/journal.ts` |
| `tests/journal-durability.test.ts` | 4 | `src/learning/journal.ts` — **dynamic import**, `:17` (F4) |
| `tests/learning.test.ts` | 3 | `src/learning/{analyzer,journal}.ts` |
| `tests/tui.test.ts` | 2 | `src/tui.ts` |

Delete-set whose only surviving import is `src/config.ts` as a config-shape helper (8 files, 81 tests)
— the subject under test is deleted in every case:

| File | Tests | Subject |
|------|------:|---------|
| `tests/signals.test.ts` | 28 | `src/strategy/signals.ts` |
| `tests/strategy-risk.test.ts` | 13 | `src/strategy/risk.ts` |
| `tests/executor.test.ts` | 10 | `src/executor.ts` |
| `tests/startup-safety.test.ts` | 10 | `src/startup-safety.ts` |
| `tests/integration.test.ts` | 8 | the whole 5m signal→executor→journal path |
| `tests/candle-cadence.test.ts` | 6 | `src/strategy/candles.ts` |
| `tests/fill-model.test.ts` | 4 | `src/strategy/backtest.ts` post-only fill model |
| `tests/backtest.test.ts` | 2 | `src/strategy/backtest.ts` |

Fixture: delete `tests/fixtures/aptusdt-klines-15m.json` (E24). **Keep**
`tests/fixtures/apt-usdt-session-2026-09-07.json` (F10, E23) and every file under
`tests/fixtures/research/` (all daily).

**Trim — 4 kept test files, 28 tests removed:**

| File | Now | Remove | After |
|------|----:|--------|------:|
| `tests/bybit.test.ts` | 34 | the 15 tests of the five removed `adapters.ts` exports: `tickerToMarketSnapshot` (`:101`, `:231`, `:240`, `:249`, `:258`), `orderResponseToTradeResult` (`:109`, `:118`), `bybitPositionToPosition` (`:162`, `:182`), `walletToTotalUsd` (`:190`, `:199`, `:203`), `walletAvailableBalance` (`:211`, `:218`, `:225`); and the corresponding names from the import block (`:9-15`) | 19 |
| `tests/rest-client.test.ts` | 17 | `"placeOrder maps SDK errors to our error types"` (`:102`), `"cancelOrder delegates to SDK"` (`:164`) | 15 |
| `tests/circuit-breaker.test.ts` | 12 | the 3 `checkSlippage` tests (`:94`, `:100`, `:105`) and `checkSlippage` from the import (`:5`) | 9 |
| `tests/config.test.ts` | 20 | the 8 tests asserting validation of retired keys: `stopLossPercent` (`:50`), `refreshIntervalMs` (`:65`), `maxPositionSizeUsd` (`:94`), `maxDailyTrades` (`:109`), `takeProfitPercent` (`:139`), `liquidationBufferPercent` (`:225`), `maxConcurrentPositions` (`:306`), `maxCorrelation` (`:322`); **and rewrite**, not delete, the exhaustive round-trip at `:177` to cover the surviving key set (E13) | 12 |

**Arithmetic (this is the AC in §6):** 833 − 284 = **549** after step 8b; 549 − 28 = **521** after
step 8c, across **40** test files.

### 5.5 `package.json` changes

- **Remove `"start"`** (`:10`) and **`"dashboard"`** (`:11`) — both `node ... src/main.ts` (E17).
- **Do not add a pointer script.** A `"start": "echo 'retired — see docs/DAILY_WORKFLOW.md'"` is a
  shim that will outlive its explanation. `npm run start` failing with npm's own "Missing script:
  start" plus the list of available scripts is a clearer signal, and the README names the real
  entrypoints (§5.8.1).
- **Keep unchanged:** `typecheck`, `test`, `verify`, `snapshot:daily`, `research:daily`, `journal`,
  `backfill`, `backtest:daily`, `decide`, `farside:import`.
- **Keep every dependency.** `bybit-official-ts-sdk` is still used by `src/bybit/rest.ts` for reads;
  `hono`/`@hono/node-server` by `src/server/journal-server.ts`; `@anthropic-ai/sdk`/`zod` by
  `src/research/ai/`. `devDependencies` unchanged.
- **Update `"description"`** (`:4`) — it currently reads "multi-indicator strategy, learning system,
  and real-time web dashboard", which is the deleted product (E20).

### 5.6 `src/config.ts` — keys to drop and keys to keep

**Migration behavior (F6, E11): unknown keys are already ignored, and this spec does not change that.**
`loadConfig` reads `raw["<key>"]` for each key it knows (`:316-352`) and never inspects `raw` for extra
properties, so a retired key left in a real `config.json` is silently ignored from the moment its line
is removed. No migration step, no config rewrite, no version field. Adding unknown-key rejection is
explicitly **not** done (§12 A2, §13).

**Keep (13):** `exchange`, `apiKey`, `apiSecret`, `symbols`, `maxCapitalUsd`, `riskPerTradePercent`,
`maxDailyLossPercent`, `maxDrawdownHaltPercent`, `maxConsecutiveLosses`, `maxSlippagePercent`,
`manual`, `ai`, `persona`, plus every `*Config` interface, `DEFAULT_*_CONFIG`, `resolve*Config`,
`validate*Config` and `ConfigError`.

Evidence for each keep: `exchange`/`apiKey`/`apiSecret` → `src/server/journal-server.ts:607-611`;
`symbols` → `journal-server.ts:612`, `src/backtest-daily/gate-d0.ts:57`, all six daily scripts;
`maxCapitalUsd` → `src/journal/breaker.ts:22,43,55`, `scripts/decide-daily.ts:289`;
`riskPerTradePercent` → `src/research/planner.ts:20,169`, `scripts/{backtest-daily:216,decide-daily:270,research-daily:259}`;
the four breaker percentages → `journal-server.ts:169-172`, `scripts/decide-daily.ts:283-286`,
`scripts/research-daily.ts:279-282`.

**Drop (25)** — every one has zero references in `src/research/`, `src/journal/`, `src/decision/`,
`src/backtest-daily/`, `src/server/journal-server.ts` or the six daily scripts:

| Key | Declared | Was read by |
|-----|---------|-------------|
| `maxPositionSizeUsd` | `:11` | `src/main.ts:673`, `src/strategy/{risk:38,signals:429,symbol-recommender:64}` |
| `maxDailyTrades` | `:12` | `src/main.ts:262`, `src/strategy/signals.ts:286` |
| `stopLossPercent` | `:13` | `src/main.ts:123`, `src/strategy/{backtest:206,model:43,risk:15}` |
| `takeProfitPercent` | `:14` | `src/main.ts:122`, `src/strategy/{backtest:207,model:42,signals:67}` |
| `refreshIntervalMs` | `:15` | `src/main.ts:50,188,626` (the 5m cadence itself) |
| `autoSelectSymbols` | `:16` | `src/main.ts:670`, `src/strategy/symbol-recommender.ts` |
| `liquidationBufferPercent` | `:20` | `src/main.ts:761,785,788` |
| `maxCapitalUsdWarnThreshold` | `:37` | `src/startup-safety.ts:32,64` |
| `atrStopMultiplier` | `:49` | `src/strategy/risk.ts:16,28,33` |
| `cashReservePercent` | `:52` | `src/strategy/risk.ts:29,36` |
| `maxConcurrentPositions` | `:58` | `src/main.ts:348`, `src/strategy/concentration.ts:18` |
| `maxCorrelation` | `:62` | `src/main.ts:357`, `src/strategy/concentration.ts:69` |
| `signalConfirmationTicks` | `:68` | `src/strategy/signals.ts:490` |
| `minHoldBeforeExpertExitMs` | `:72` | `src/strategy/signals.ts:355` |
| `estimatedRoundTripFeePercent` | `:87` | `src/strategy/risk.ts:62` — **move its provenance comment (`:77-83`) to `ManualTradingConfig.roundTripFeePercent` (`:231`) before deleting it** (F10) |
| `useModelGate` | `:95` | `src/strategy/signals.ts:64,456` |
| `modelMinProbability` | `:99` | `src/strategy/signals.ts:107` |
| `modelTopPercentile` | `:111` | `src/strategy/signals.ts:105` |
| `simulatedMakerFeePercent` | `:116` | `src/executor.ts:81`, `src/strategy/risk.ts:60` |
| `simulatedTakerFeePercent` | `:120` | `src/executor.ts:82`, `src/strategy/risk.ts:61` |
| `usePostOnlyEntries` | `:136` | `src/bybit/connector.ts:731`, `src/executor.ts:76` |
| `usePostOnlyTakeProfitExits` | `:158` | `src/executor.ts:71,78` |
| `postOnlyTimeoutMs` | `:161` | `src/bybit/connector.ts:544` |
| `postOnlyRestBars` | `:171` | `src/strategy/backtest.ts:128,271` |
| `postOnlyHalfSpreadPercent` | `:175` | `src/strategy/backtest.ts:268` |

For each: remove the `Config` field, its line in the `raw[...]` block (`:316-352`) and its validation
block. The five mandatory ones (`maxPositionSizeUsd`, `maxDailyTrades`, `stopLossPercent`,
`takeProfitPercent`, `refreshIntervalMs`) lose the `throw new ConfigError` at `:384-401`, which is the
point: the daily system stops requiring five numbers it never reads (F6).

**`config.template.json` — rewrite** (E18). New content: `exchange`, `apiKey`, `apiSecret`, `symbols`
(`["BTC/USDT", "ETH/USDT"]`, per `specs/daily-catalyst-manual-trading.md` A27), `maxCapitalUsd`,
`riskPerTradePercent` (≤ 1 — the revision-1 hard cap at `src/config.ts:521-523`), and a `manual: {}`
block that documents the presence-triggered cap. `ai` and `persona` stay omitted so a fresh checkout
starts with both channels off, matching `DEFAULT_AI_ANALYST_CONFIG.enabled = false` (`:273`).

### 5.7 `data/` and `.gitignore`

- **Delete:** `data/model/scalping-model.json` (4 KB; `DEFAULT_MODEL_PATH` in the deleted
  `src/strategy/model.ts`).
- **Keep all eight `data/validation/*.json`** — including the 54 MB of walk-forward artifacts. They are
  the evidence for E1 and are cited by filename at `specs/daily-catalyst-manual-trading.md:129-130`
  (F9, §12 A4).
- **Keep** `data/{ai-rules,decisions,manual}/` and `data/ai-usage.jsonl` (all daily, committed audit
  trail).
- **Untracked/ignored and therefore nothing to delete in git:** `data/klines/`, `data/klines-365/`,
  `data/validation/crosscheck/`, `data/validation/folds/`. None exist in this worktree. The owner may
  remove them from any local checkout; §7 covers the case where they don't.
- **`.gitignore` — remove the rules for deleted outputs:** `learning-insights.json` (`:14`, `:22`),
  `trade-journal.json*` (`:17-19`), `pending-orders.json*` (`:20-21`), `data/klines/` (`:28-29`),
  `data/klines-365/` (`:31-34`), the `crosscheck/**` block (`:40-46`), `data/validation/folds/`
  (`:51-52`). Keep every `config*.json` secret rule (`:4-9`, `:36-38`) and every daily-system rule
  (`:54-78`) untouched.

### 5.8 Docs and specs

#### 5.8.1 Delete (4)

`docs/ARCHITECTURE.md`, `docs/STRATEGY.md`, `docs/USER_GUIDE.md`, `docs/RISK_MANAGEMENT.md` — all four
are scalper-only end to end (E21) and three of them document a nonexistent `optimizer.ts` (E19).

#### 5.8.2 Rewrite (5)

| File | What must be true afterwards |
|------|------------------------------|
| `README.md` | Title and opening paragraph describe the **daily catalyst, manual-execution** system. Quick start is `npm run research:daily` → `npm run decide` → `npm run journal` (port 3082), not `npm run dashboard`. The project-structure block lists `src/research/`, `src/journal/`, `src/backtest-daily/`, `src/decision/`, `src/server/journal-server.ts`, `src/bybit/{rest,adapters,rate-limiter,types}.ts`, `src/risk/circuit-breaker.ts`, `src/config.ts` — and nothing that does not exist (E19). The doc table drops the four deleted docs. The test count is 521, not 81 (`:24`). One sentence states that the 5-minute auto-trader was retired in Phase 8, with this spec's path. |
| `AGENTS.md` | **§1 Identity** (`:11-15`): the repo is the daily system; execution is manual; the repo cannot place orders. **§4 Bybit conventions** (`:91-126`): drop §4.3 WebSocket topics and §4.4 order quantity; keep rate-limiting and read-only-key rules. **§6** (`:145-173`): replace "Three Pillars" / "Main Loop" / "Bybit Connection Flow" with the daily pipeline (snapshot → research → decide → manual execution → journal sync) and state that there is no loop and no order path. **§10 Project Skills** (`:252-258`): `crypto-fundamental-analyst`. **§11 Useful Commands** (`:260-284`): drop `npm run start`/`dashboard`/testnet/live lines; list the daily scripts. Add one line under §5 (Security Rules): *no module in this repo may place, amend or cancel an order, or set leverage or margin mode — see `specs/retire-scalper.md` §3 P1 and §9 gate 4.* |
| `docs/SETUP.md` | Install + `config.template.json` walkthrough for the **daily** key set (§5.6), the two read-only Bybit env vars (`BYBIT_READONLY_API_KEY`/`_SECRET`), `FRED_API_KEY`, and the daily scripts. Remove "Paper Trading (no API keys needed)", the testnet/mainnet `--live` sections, ports 3081, and the stale "81 tests" (`:22`). |
| `docs/BYBIT_INTEGRATION.md` | Keep and correct what is still true: API-key creation with **read-only** permissions only, rate limits, troubleshooting. Remove the WebSocket+REST hybrid architecture (`:6-30`), the connection lifecycle (`:96-108`) and every mainnet-trading instruction (`:75-95`). State that the key must have no trade or withdraw permission and that `assertReadOnlyKey` (`src/journal/exchange-sync.ts:47`) enforces it at server start. |
| `docs/DAILY_WORKFLOW.md` | `:549-551` explains that narrowing `config.symbols` silently narrowed `src/main.ts`'s universe (A33). Replace with one sentence recording that the auto-trader was deleted in Phase 8, so the shared-field caveat no longer applies. No other change — this doc is the daily system's own and stays authoritative. |

#### 5.8.3 Mark superseded, keep in place (3)

Add this header — nothing else — immediately under the title of each, and **do not move or rename the
files** (F8: their paths are cited from `specs/daily-catalyst-manual-trading.md` and from each other):

```
> **Superseded — historical record.** This spec describes the 5-minute auto-trader, deleted in
> Phase 8 (`specs/retire-scalper.md`). Its code is recoverable at commit `65988db`. The measured
> results here remain valid evidence and are cited by later specs; the design and the plan are not
> current. The current system is `specs/daily-catalyst-manual-trading.md`.
```

- `specs/profit-target-roadmap.md` — also the source of E1's numbers (`:3-7`).
- `specs/strategy-signal-quality.md`
- `specs/live-trading-readiness.md` — its findings F1–F17 concern the deleted order path; the
  circuit-breaker and read-only-key findings survive in the daily system.

`specs/daily-catalyst-manual-trading.md` gets **two** small edits and no header: mark the §9 Phase 8
row (`:2220`) as decided by this spec, and update §11's "Modifying or deleting `src/main.ts` … (Phase 8
needs its own spec)" (`:2283`) to point here. `specs/retire-scalper.md` (this file) is the current
spec for Phase 8.

### 5.9 The one addition — relocate `percentile`

Required by F1, and the **first** thing to land (§8a).

Move `src/strategy/walkforward.ts:109-113` verbatim into `src/backtest-daily/stats.ts`, exported, with
a comment recording where it came from:

```ts
/** Nearest-rank quantile: the value at index floor(n·q), clamped to the last element.
 *  Moved verbatim from src/strategy/walkforward.ts:109 when the 5m harness was deleted
 *  (specs/retire-scalper.md §5.9); it is the only symbol the daily system used from there. */
export function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}
```

Then:

- delete `src/backtest-daily/stats.ts:11` (the cross-boundary import);
- repoint `tests/backtest-stats.test.ts` to import `percentile` from `../src/backtest-daily/stats.ts`
  (it uses it at `:76` to recompute the expected bootstrap CI);
- change nothing else. `bootstrapCi90` (`stats.ts:53`), `d0Block30P10` (`:77`) and their three call
  sites (`:68`, `:95`) keep identical behavior — `percentile` is byte-identical, so Gate D0/D1 numbers
  must not move (AC-3).

`median` and `binomialUpperTail` are **not** moved, and neither are the other four exports
(`DAY_MS`, `WalkForwardError`, `buildFolds`, `runWalkForward` and the report types): nothing outside
the delete set imports any of them (E5, E5a).

**Do not "simplify" this into reusing `scripts/exit-mix.ts:74`'s `quantile`** — that file is deleted
in the same phase (§5.1), and its helper is a coincidental duplicate (E4), not a shared utility. The
duplication is cited as evidence that the move is trivial, not as a source to move *from*: the
authoritative body is `walkforward.ts:109-113`, which is what AC-3 diffs against.

---

## 6. Acceptance criteria

Each is a command with an expected result, runnable from the repository root. The phase that must
make it true is named. All commands are `rg`, `npm`, `git` or `node` — no new tooling.

**Structural — the scalper is gone (P0)**

- **AC-1** `git ls-files src scripts crosscheck | rg "^(src/(main|tui|logger|instance-lock|startup-safety|executor|market|portfolio)\.ts|src/(strategy|learning)/|src/server/(index\.ts|public/index\.html)|src/bybit/(connector|ws|pending-orders)\.ts|src/risk/wallet-monitor\.ts|scripts/(train-model|walk-forward|backtest|fetch-klines|export-folds|crosscheck-export|barrier-sweep|exit-mix)\.ts|scripts/auc_feasibility\.py|crosscheck/)"` → **no output**. (8b)
- **AC-2** `rg -n 'from "\.\./strategy/|from "\./strategy/|from "\.\./\.\./strategy/|strategy/(signals|indicators|risk|backtest|walkforward|model|candles|bars|features|training|concentration|exit-reason|symbol-recommender)\.ts' src scripts tests` → **no output**. (8b)
- **AC-3** `src/backtest-daily/stats.ts` exports `percentile` with a body byte-identical to
  `git show 65988db:src/strategy/walkforward.ts | sed -n '109,113p'`, and
  `node --test --experimental-strip-types tests/backtest-stats.test.ts tests/backtest-gate-d0.test.ts tests/backtest-gate-d1.test.ts tests/backtest-simulate.test.ts tests/backtest-permutation.test.ts`
  → all pass with **unchanged** numeric expectations (no test expectation edited in step 8a). (8a)

**Capability surface — P4 becomes structural (P0)**

- **AC-4** `rg -n "placeOrder|createOrder|cancelOrder|setLeverage|setMarginMode|amendOrder|submitOrder" src scripts` → **no output at all**, not merely none outside the daily directories. This is strictly stronger than `specs/daily-catalyst-manual-trading.md:2305`, which scopes the same grep to the daily modules. (8c)
- **AC-5** `rg -n "/v5/order/create|/v5/order/amend|/v5/order/cancel|/v5/position/set-leverage" src` → **no output**. (8c)
- **AC-6** `src/journal/exchange-sync.ts:47`'s `assertReadOnlyKey` is unchanged, and
  `node --test --experimental-strip-types tests/journal-exchange-sync.test.ts` passes (20 tests): the
  runtime guard survives as defence in depth (§3 P1). (8c)
- **AC-7** `rg -n "^import" src/bybit/adapters.ts` → **no output** (the trimmed module imports
  nothing, F2/E8). (8c)

**Tests — exact counts (P0)**

- **AC-8** After 8b: `npm test` reports `tests 549`, `pass 549`, `fail 0`, and
  `git ls-files 'tests/*.test.ts' | wc -l` → `40` (it is `63` today). Note the quoted pathspec:
  `git ls-files` does not take `--glob`. (8b)
- **AC-9** After 8c: `npm test` reports `tests 521`, `pass 521`, `fail 0`. (8c)
- **AC-10** `rg -n 'import\(`\.\./src' tests` → **no output** (no test reaches a deleted module by
  dynamic import, F4/E16). (8b)
- **AC-11** `rg --files tests | rg "^tests/.+/.+\.test\.ts$"` → **no output** (unchanged from
  `specs/daily-catalyst-manual-trading.md:2304`; the non-recursive glob still sees every test). (8b)
- **AC-12** `rg -n "aptusdt-klines-15m" src scripts tests` → **no output**, and
  `git ls-files tests/fixtures/aptusdt-klines-15m.json` → **no output**. Scoped to code on purpose:
  `specs/strategy-signal-quality.md:484` legitimately cites the deleted fixture as the input to a
  historical measurement, exactly as it cites deleted code, and its superseded header (§5.8.3) is what
  frames that. Meanwhile `git ls-files tests/fixtures/apt-usdt-session-2026-09-07.json` → **one line**
  (F10). (8b)

**Config (P1)**

- **AC-13** Given a `config.json` containing all 25 retired keys of §5.6 **plus** the 13 kept ones,
  when `loadConfig` runs, then it returns without throwing and the returned object has **none** of the
  25 as own properties. Expressed as a test in `tests/config.test.ts`: `assert.deepEqual(Object.keys(loadConfig(p)).filter(k => RETIRED.includes(k)), [])`. This is the migration guarantee of F6/E11, asserted rather than assumed. (8c)
- **AC-14** Given a `config.json` with **only** the 13 kept keys and no `manual`/`ai`/`persona`, when
  `loadConfig` runs, then it returns without throwing — i.e. `stopLossPercent`, `takeProfitPercent`,
  `refreshIntervalMs`, `maxPositionSizeUsd` and `maxDailyTrades` are no longer required. (8c)
- **AC-15** `tests/config.test.ts`'s round-trip test (`:177`) enumerates exactly the surviving key set,
  and `rg -n "stopLossPercent|takeProfitPercent|refreshIntervalMs|maxPositionSizeUsd|maxDailyTrades|useModelGate|postOnly|simulated(Maker|Taker)FeePercent|atrStopMultiplier|cashReservePercent|maxConcurrentPositions|maxCorrelation|signalConfirmationTicks|minHoldBeforeExpertExitMs|estimatedRoundTripFeePercent|modelMinProbability|modelTopPercentile|liquidationBufferPercent|maxCapitalUsdWarnThreshold|autoSelectSymbols" src/config.ts config.template.json` → **no output**. (8c)
- **AC-16** `rg -n "roundTripFeePercent" -B 8 src/config.ts` shows the
  `apt-usdt-session-2026-09-07.json` provenance note now attached to
  `ManualTradingConfig.roundTripFeePercent` (F10). (8c)
- **AC-17** `node --experimental-strip-types -e 'import("./src/config.ts").then(m => m.loadConfig("./config.template.json"))'` exits 0 — the shipped template is loadable as written. (8c)

**Scripts and runtime (P1)**

- **AC-18** `rg -n '"start"|"dashboard"' package.json` → **no output**; `npm run start` exits non-zero
  with npm's own "Missing script" message (§5.5). (8b)
- **AC-19** Given `npm run journal` running, then: (a) `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3082/api/state` prints `200`; (b) when the process is sent `SIGINT`, `kill -0 <pid>` fails within 2 s (it is gone, not hung); and (c) the run's captured stderr contains no match for
  `rg "ERR_MODULE_NOT_FOUND|Cannot find module|UnhandledPromiseRejection|^\s+at .*\(node:internal"` —
  i.e. it served and then died to the signal, rather than crashing on a module the trim removed.
  Scriptable as: `npm run journal 2>err.log & P=$!; sleep 3; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3082/api/state; kill -INT $P; sleep 2; kill -0 $P 2>/dev/null && echo "STILL RUNNING — FAIL"; rg -c "ERR_MODULE_NOT_FOUND|Cannot find module|UnhandledPromiseRejection" err.log`
  → expects `200`, no `STILL RUNNING`, and no stderr match.
  **This deliberately does not assert exit code 0.** `src/server/journal-server.ts` installs no
  `SIGINT`/`SIGTERM` handler (`rg -n "SIGINT|SIGTERM|process\.on\(" src/server/journal-server.ts` →
  only `:628`'s `process.exitCode = 1` on `TradePermissionKeyError`), so Node applies the signal's
  default action and the shell reports 130, not 0 — today and after this change alike. Requiring 0
  would be requiring a graceful-shutdown handler this spec has no business adding (§3 P5, §11); it is
  deferred in §13. What AC-19 must catch is the failure this phase can actually cause: a server that
  no longer starts, no longer answers, or dies on a module `src/bybit/rest.ts`'s trim removed. (8c)
- **AC-19a** **[manual]** With `BYBIT_READONLY_API_KEY`/`_SECRET` exported, `GET /api/state` reports
  `liveSync: "enabled"`, `lastSync.status: "ok"` and `error: null` — the same assertion as
  `docs/validation/live-readiness.md` row 1, re-run after the trim of `src/bybit/rest.ts` because that
  trim edits the class holding the live credential. Manual because it requires a real read-only key
  and a live Bybit round trip, which no unit test may do (`specs/daily-catalyst-manual-trading.md:2242`).
  Append a dated row to `docs/validation/live-readiness.md`; do not edit row 1. (8c)
- **AC-20** `npm run research:daily -- --date <yesterday>` and `npm run decide -- --date <yesterday>`
  both reach their normal exit codes against existing artifacts, with no module-resolution error.
  **[manual]** (8c)
- **AC-21** `npm run verify` is green at `HEAD` after **each** of 8a, 8b, 8c, 8d — verified by
  `git rebase --exec 'npm run verify' <base>` over the four commits (§3 P3). (8d)

**Documentation (P1)**

- **AC-22** `rg -n "optimizer\.ts|Three Pillars|npm run dashboard|npm run start|localhost:3081|Kelly|indicatorsAtEntry" README.md AGENTS.md docs --glob '!docs/SECURITY_PLAYBOOK.md'` → **no output** (E19, E20, E21). (8d)
- **AC-23** `git ls-files docs` → does not list `ARCHITECTURE.md`, `STRATEGY.md`, `USER_GUIDE.md` or
  `RISK_MANAGEMENT.md`; and `rg -n "ARCHITECTURE\.md|STRATEGY\.md|USER_GUIDE\.md|RISK_MANAGEMENT\.md" README.md AGENTS.md docs specs` → **no output** (no dangling link). (8d)
- **AC-24** Every file in `src/` and `scripts/` named in `README.md`'s project-structure block exists:
  for each path in that block, `git ls-files <path>` returns it. (8d)
- **AC-25** `rg -n "^> \*\*Superseded" specs/profit-target-roadmap.md specs/strategy-signal-quality.md specs/live-trading-readiness.md` → **three** matches, one per file, and all three files are still at
  their original paths (F8). (8d)
- **AC-26** `rg -n "Phase 8" specs/daily-catalyst-manual-trading.md` shows the `:2220` row and `:2283`
  out-of-scope line pointing at `specs/retire-scalper.md` rather than at an undecided future spec. (8d)
- **AC-27** `rg -n "place, amend or cancel an order" AGENTS.md` → **at least one** match under §5
  (§5.8.2). (8d)

**Hygiene (P2/P3)**

- **AC-28** `git ls-files data/validation | wc -l` → `8` (all scalper validation artifacts kept, F9);
  `git ls-files data/model` → **no output**. (8b)
- **AC-29** `rg -n "learning-insights|trade-journal\.json|pending-orders\.json|data/klines|crosscheck/|validation/folds" .gitignore` → **no output**, while `rg -n "^config\.json$|manual-journal\.json" .gitignore` still matches (F11, §5.7). (8d)
- **AC-30** `git log --oneline <base>..HEAD | wc -l` → `4`, and each commit message follows the
  conventional-commit form with a `specs/retire-scalper.md` §-reference for the step it implements. (8d)

---

## 7. Error & edge behavior for the transition (fail-closed table)

Default for every row: **halt the step and surface it; never delete on a guess, never leave a green
gate lying** (§3 P2, L-008). "Closed" below means the failure stops the step rather than being worked
around.

| Case | Behavior | Stance |
|------|----------|--------|
| A real `config.json` still contains retired keys after 8c | Ignored, by `loadConfig`'s existing allow-list (E11). Asserted by AC-13. The owner's file is **not** edited by this change. | Closed (no breakage to fail) |
| A real `config.json` is missing a **kept** key that used to be optional | Unchanged behavior: `loadConfig` throws `ConfigError` for the five it always required among the kept set (`exchange`, `apiKey`, `apiSecret`, `symbols`, `maxCapitalUsd`) — §5.6 removes required-ness, never adds it. | Closed |
| A retired key is *later* re-added to `config.json` by hand, expecting an effect | Silently ignored — no code reads it. Mitigation is documentation, not validation: `config.template.json` ships only live keys (AC-17) and the retired list lives in §5.6 of this spec. §12 A2 records the accepted risk; §13 names unknown-key rejection as the deferred alternative. | Open, deliberately |
| A systemd unit, cron line or shell alias outside the repo still runs `npm run start` or `node src/main.ts` | The command fails loudly: `npm` prints "Missing script: start" and lists available scripts; `node src/main.ts` fails with `ERR_MODULE_NOT_FOUND`. Neither silently starts anything, and neither can place an order (AC-4). **The owner must check their own units** — nothing in the repo can do it for them (E26: there is no unit in the repo to update). §9 gate 8 makes it a manual step. | Closed (fails, never degrades) |
| A systemd unit points at a **daily** script (`snapshot:daily`, `research:daily`) | Unaffected — §5.5 changes no daily script name or path. Verified by AC-20. | n/a |
| `npm test` after 8b reports a total other than 549 | **Stop.** Do not adjust the AC to match. A lower number means a test file was deleted that §5.4 did not list; a higher one means a delete-set file was missed, **or** work landed after `65988db` and added tests (see the next row). Reconcile the arithmetic explicitly — `833 − 284` against the then-current baseline — before the commit lands; never edit the AC to whatever the runner printed. | Closed |
| Work landed after `65988db` (Phase 7's `coinalyze-oi` source and §5.16, the notification flag, the CSV endpoint), so the baseline test total is no longer 833 and new files exist that §5 never inventoried | **Re-baseline, do not re-scope.** Before 8b: (1) record the new `npm test` total `T`; AC-8 becomes `T − 284` and AC-9 becomes `T − 284 − 28`, with the arithmetic in the commit message (the measurement basis note at the top of this document states the rule). (2) Re-run §5.1's reachability check — the six daily entrypoints plus `src/server/journal-server.ts`, over every relative `import`/`import()` — on the then-current tree, and confirm no post-`65988db` file imports a delete-set module. A new import of `src/strategy/*`, `src/executor.ts`, `src/market.ts`, `src/portfolio.ts` or `src/learning/*` is an F1-class finding: add it to §2.1, decide keep-vs-relocate under §3 P2, and extend 8a — do **not** delete through it. (3) **No Phase 7 file is added to any delete, trim or rewrite list by this spec.** If a Phase 7 file needs changing, that is a §5 amendment with its own evidence row, not an implementer's judgement call mid-deletion. | Closed |
| `tsc --noEmit` fails during 8b with an error in a **daily** file | **Stop and revert the step.** It means §5.1's reachability analysis missed an edge (the F1 class of error). Add the edge to §2.1, decide keep-vs-relocate under §3 P2, and re-run 8a first. Do not add an `any`, a re-export shim, or a `@ts-expect-error` to get the step green. | Closed |
| A fixture has no loader and looks deletable | Check what *cites* it before deleting, not just what loads it. `tests/fixtures/apt-usdt-session-2026-09-07.json` is loaded by nothing already today (E23) yet is the measured source of a live daily default (F10) — keep. `tests/fixtures/aptusdt-klines-15m.json` is loaded by two delete-set tests and cited only by a superseded spec — delete. `tests/fixtures/research/**` is daily-only and untouched. | Closed (keep unless both the loader and the citation are dead) |
| A deleted module is referenced from a **committed** artifact under `data/` | Leave the artifact alone. `data/validation/*.json` and `data/ai-rules/*.json` are historical records; a record that names the code that produced it is correct, not stale. Only `data/model/scalping-model.json` is deleted, and it is an *input* to deleted code, not a record of a conclusion (F9). | Closed (keep) |
| `docs/validation/live-readiness.md` row 1 was passed against the **untrimmed** `rest.ts` | Re-run it (AC-19a). The trim removes four methods from `RestClient`; the read path the check exercised (`getPositions`, `getExecutions`, `getApiKeyInfo`) is untouched, but "untouched by inspection" is not the same as "re-verified". Append a new dated row; do not edit the old one. | Closed |
| An `rg` AC returns output because a **string literal or comment** still names a removed symbol | Treat as a real failure of that AC and remove the mention. A comment that says `placeOrder` in a repo that cannot place orders is exactly the F7 harm: it sends the next reader looking. `src/bybit/types.ts:261`, `src/bybit/adapters.ts:56`, `src/bybit/rest.ts:10` and `src/strategy/backtest.ts:7` all carry such comments today. | Closed |
| The four `walk-forward-*.json` artifacts make a clone slow or large and the owner wants them gone | Not done by this spec (F9). The honest form is §13's: inline E1's numbers into `specs/profit-target-roadmap.md:3-7` as a table **first**, so the claim survives without the artifact, then delete in a separate commit. Deleting the evidence and the code together is refused. | Closed |
| Step 8d (docs) is skipped or deferred "for later" | Phase 8 is **not** done (§8 go/no-go). A repo whose `AGENTS.md` still documents an order-placing main loop after AC-4 passes is the F7 failure mode, and it is the half that affects every future agent. | Closed |
| `git stash` is used to carry work between steps | Don't. Each step is a commit (§3 P3); a stash in a shared worktree stack is a way to lose one system's deletion into another session's pop. | Closed |

---

## 8. Phased plan

Four commits, in this order. The order is forced by §3 P3: relocate before deleting (F1), delete
consumers before trimming their dependency (F2), and document last, once the tree is final.

**Severity gate (L-007):** **Phase 8 is complete only when 8a, 8b, 8c and 8d have all landed with
every P0 and P1 acceptance criterion green. 8a–8c are P0 and must not be split across a release
boundary: between 8b and 8c the repo has no auto-trader but still carries `placeOrder`,
`cancelOrder`, `setLeverage` and `setMarginMode` in a client the journal server instantiates with
real credentials (F3) — that is the one intermediate state that is worse than either end, and it must
not be left standing. 8d is P1: without it the repo still tells every reader and every agent that it
is a 5-minute auto-trader (F7). No real-capital daily trading decision depends on any of this — this
spec places no orders and changes no plan, size, leverage or gate — so the go/no-go here is about the
repository's honesty and capability surface, not about capital.**

### Phase 8a — Relocate `percentile`, remove the entrypoint scripts (P0)

- [ ] Add `percentile` to `src/backtest-daily/stats.ts` verbatim (§5.9); delete
      `src/backtest-daily/stats.ts:11`.
- [ ] Repoint `tests/backtest-stats.test.ts`'s import. Edit **no** numeric expectation.
- [ ] Remove `"start"` and `"dashboard"` from `package.json`; update `"description"` (§5.5).

**Verification:** `npm run typecheck` clean; `npm test` → `tests 833 / pass 833` (nothing deleted yet,
so the total must not move); AC-3, AC-18.
**Go/no-go:** if any `backtest-daily` numeric expectation had to change, `percentile` was not moved
verbatim — stop and diff against `git show 65988db:src/strategy/walkforward.ts`.

### Phase 8b — Delete the modules, scripts, tests and data (P0)

- [ ] Delete the 29 `src/` paths of §5.1 (and the now-empty `src/strategy/`, `src/learning/`).
- [ ] Delete the 9 `scripts/` paths and `crosscheck/` (§5.1 header, E25).
- [ ] Delete the 23 test files of §5.4 and `tests/fixtures/aptusdt-klines-15m.json`.
- [ ] Delete `data/model/scalping-model.json`. Keep every `data/validation/*.json` (F9).

**Verification:** `npm run typecheck` clean; `npm test` → `tests 549 / pass 549 / fail 0`; AC-1, AC-2,
AC-8, AC-10, AC-11, AC-12, AC-28.
**Go/no-go:** a `tsc` error in any file under `src/research/`, `src/journal/`, `src/decision/`,
`src/backtest-daily/` or `src/server/journal-server.ts` means §5.1 is wrong — revert the step and fix
§2.1 (§7, row "tsc fails in a daily file"). A test total other than 549 means §5.4 is wrong — same
rule.

### Phase 8c — Trim the shared files (P0 — this is where P4 becomes structural)

- [ ] `src/bybit/adapters.ts`: remove the five exports and the four imports (§5.3, F2).
- [ ] `src/bybit/rest.ts`: remove `placeOrder`, `cancelOrder`, `setLeverage`, `setMarginMode` (F3).
- [ ] `src/bybit/types.ts`: remove the WS block, the order/position DTOs, `BybitFillUncertainError`,
      the four `ENDPOINT_LIMITS` entries, and `BybitConfig`'s three fields; drop
      `wsPingIntervalMs: 20_000` at `src/server/journal-server.ts:613`. Keep all six error classes
      `classifyError` constructs.
- [ ] `src/risk/circuit-breaker.ts`: remove `checkSlippage`; keep `CircuitBreakerConfig.maxSlippagePercent`.
- [ ] `src/config.ts`: remove the 25 keys, their `raw[...]` lines and their validation blocks; move the
      fee provenance comment to `ManualTradingConfig.roundTripFeePercent` (§5.6, F10).
- [ ] Rewrite `config.template.json` (§5.6).
- [ ] Trim the 4 kept test files (§5.4, 28 tests) and rewrite `tests/config.test.ts:177`'s round-trip;
      add the AC-13 and AC-14 tests.
- [ ] Remove every comment and string in `src/` that still names a deleted symbol (§7, `rg` row).

**Verification:** `npm run typecheck` clean; `npm test` → `tests 521 / pass 521 / fail 0`; AC-4, AC-5,
AC-6, AC-7, AC-9, AC-13..AC-17, AC-19 (journal server starts, answers 200, exits 0 on SIGINT).
**[manual]** AC-19a (live read-only sync) and AC-20.
**Go/no-go:** AC-4 must return literally nothing across all of `src` and `scripts`. If it does not,
the capability the phase exists to remove is still there and the phase is not done.

### Phase 8d — Documentation, specs and hygiene (P1)

- [ ] Delete the 4 docs of §5.8.1.
- [ ] Rewrite `README.md`, `AGENTS.md`, `docs/SETUP.md`, `docs/BYBIT_INTEGRATION.md` and
      `docs/DAILY_WORKFLOW.md:549-551` per §5.8.2.
- [ ] Add the superseded header to the 3 specs; edit
      `specs/daily-catalyst-manual-trading.md:2220` and `:2283` (§5.8.3).
- [ ] Trim `.gitignore` (§5.7).
- [ ] Append a dated row to `docs/validation/live-readiness.md` recording AC-19a's re-run.

**Verification:** AC-21 (`git rebase --exec 'npm run verify'` over all four commits), AC-22..AC-27,
AC-29, AC-30.
**Go/no-go:** AC-24 — every path `README.md` names must exist. A structure block that lists a file the
repo does not have is E19 recreated in the commit that was supposed to fix it.

---

## 9. Verification gates (must all pass)

1. `npm run typecheck` (= `tsc --noEmit`) — zero errors, after **each** of the four commits.
2. `npm test` (= `node --test --experimental-strip-types "tests/*.test.ts"`) — `fail 0`, with the exact
   total for that step: **833** after 8a, **549** after 8b, **521** after 8c and 8d (AC-8, AC-9).
   "All green" alone is not this gate; the number is (L-004).
3. `git rebase --exec 'npm run verify' <base>` across the four commits — every commit green in
   isolation (§3 P3, AC-21).
4. `rg -n "placeOrder|createOrder|cancelOrder|setLeverage|setMarginMode|amendOrder|submitOrder" src scripts`
   → **no output**. Strictly stronger than `specs/daily-catalyst-manual-trading.md:2305`.
5. `rg -n 'import\(`\.\./src' tests` → **no output** (F4's error class cannot recur).
6. `rg --files tests | rg "^tests/.+/.+\.test\.ts$"` → **no output** (unchanged from the daily spec's
   gate 3).
7. `rg -n "optimizer\.ts|Three Pillars|npm run dashboard|localhost:3081" README.md AGENTS.md docs --glob '!docs/SECURITY_PLAYBOOK.md'`
   → **no output**.
8. **[manual, owner, before 8b lands]** Confirm no `systemd --user` unit, cron entry or shell alias on
   the owner's machine invokes `npm run start`, `npm run dashboard` or `node src/main.ts`:
   `systemctl --user list-timers --all` and `systemctl --user cat <unit>` for each, plus `crontab -l`.
   Nothing in the repository can verify this (E26) and nothing in the repository will break if it is
   skipped — it will simply fail loudly at 00:15 UTC (§7). Record the result in
   `docs/validation/live-readiness.md`.
9. **[manual, after 8c]** AC-19a: start `npm run journal` with the read-only key exported and confirm
   `/api/state` reports `liveSync: "enabled"`, `lastSync.status: "ok"`, `error: null`. This is the only
   check a unit test cannot cover, because the trim touched the class that holds the live credential
   and the assertion needs a real Bybit round trip. (AC-19 — starts, answers 200, exits 0 on SIGINT —
   is scripted and belongs to gate 2's step, not here.) Append a dated row to
   `docs/validation/live-readiness.md`; do not edit row 1.
10. **[manual, after 8c]** AC-20: one `research:daily` and one `decide` run against an existing report
    date, reaching their normal exit codes.
11. Independent reviewer verdict `approved` on each of the four diffs.
12. Independent spec-factory critique verdict `accepted` on **this document** before 8a starts (§8
    Phase 0 equivalent: acceptance of this spec *is* the phase-0 deliverable).

---

## 10. Constraints

- Node `>= 24` (measured `v24.20.0`), TypeScript strict, ESM, `--experimental-strip-types`, no build
  step — unchanged by this spec.
- **No dependency changes.** `package.json`'s `dependencies` and `devDependencies` are untouched
  (§5.5). `bybit-official-ts-sdk` stays because `src/bybit/rest.ts` still needs it for reads.
- **No new file** other than this spec. `percentile` lands in an existing file (§5.9).
- Tests must stay directly in `tests/` — the glob is non-recursive
  (`package.json:8`, `specs/daily-catalyst-manual-trading.md:139` E11).
- **Work happens in a git worktree and the branch is `feat/phase7-hardening`'s successor.** The stash
  stack is shared across worktrees; use commits, not `git stash`, to set work aside (§7).
- **`config.json` is never read by this work** — it holds live API credentials. Every statement about
  config in this spec is derived from `src/config.ts` and `config.template.json`. The owner's
  `config.json` is also never *written* by this change (§7 row 1).
- `.githooks/pre-commit` warns on any staged file matching `api[Kk]ey|apiSecret|secret|token|...`
  together with a 20+-character alphanumeric run (`.githooks/pre-commit:23`, `:32-37`). It skips
  `*.md`, so this spec is unaffected; `config.template.json` uses placeholders and is exempt by the
  `*.template.*` rule (`:28`).
- The 54 MB in `data/validation/` is a deliberate retained cost (F9, §12 A4), not an oversight.

---

## 11. Out of scope

- **Any change to daily-system behavior.** No new feature, no refactor, no "while we're here". The
  only symbol added to the daily system is `percentile` (§5.9); the only daily file otherwise edited
  is `src/server/journal-server.ts:613` (dropping one now-removed `BybitConfig` field) — and
  `tests/backtest-stats.test.ts`'s import line.
- **Removing `CircuitBreakerConfig.maxSlippagePercent`**, even though no daily code reads it
  (§5.3). It is projected into `BreakerConfig` and populated at two daily call sites; removing it is a
  daily-system change with its own ACs.
- **Trimming `rest.ts`'s unused read methods** (`syncTime`, `getKline`, `getTickers`, `getOrderbook`,
  `getInstruments`, `getRecentTrades`, `getOpenOrders`, `getOrderHistory`, `getWalletBalance`,
  `getFundingHistory`). Read-only, zero capability risk, plausibly wanted next (§3 P2, §13).
- **Adding unknown-key rejection to `loadConfig`.** It would convert a non-event into a breaking change
  for the owner's live `config.json` (F6, §13).
- **Giving the daily system any order-placing capability**, in any form, including a "close position"
  button, a helper, or a re-added `RestClient` method. This is
  `specs/daily-catalyst-manual-trading.md` P4 and §11 line 1, and this spec strengthens it rather than
  touching it.
- **Reviving, porting or parameterizing the 5m strategy** for the daily horizon. If a future spec wants
  indicator features at a daily interval, it writes them against `src/research/features.ts` with its
  own Gate D0; it does not resurrect `src/strategy/`.
- **An archive branch, a `legacy/` directory, or commented-out code** (§4, §3 P4).
- **Adding a graceful-shutdown (`SIGINT`/`SIGTERM`) handler to `src/server/journal-server.ts`.** It has
  none today, so the process dies to the signal's default action and a shell reports 130 (AC-19).
  That is pre-existing behavior, unchanged by this spec, and adding a handler would be a daily-system
  feature smuggled into a deletion (§3 P5). Deferred in §13.
- **Rewriting git history** to purge the 54 MB or the deleted code. History is the archive (§3 P4).
- **Editing the owner's `config.json`, systemd units, or crontab.** §9 gate 8 asks the owner to check
  their own units; this spec changes nothing outside the repository.
- **Renaming or moving `specs/{profit-target-roadmap,strategy-signal-quality,live-trading-readiness}.md`**
  (F8) or rewriting their content beyond the four-line header.
- **`docs/SECURITY_PLAYBOOK.md`** — 518 lines of repo-agnostic security practice, unrelated to which
  trading system exists. Untouched.
- **Retiring the `crypto-fundamental-analyst` skill, `prompts/`, or anything under `data/decisions/`,
  `data/ai-rules/`, `data/manual/`.** All live daily-system state.

---

## 12. Assumptions (for owner veto)

- **A1 — Git history is a sufficient archive; no branch or tag is created.** Everything deleted is at
  `65988db` and findable by `git log --diff-filter=D -- <path>`. If the owner wants a stable human
  label rather than a SHA, the proportionate form is `git tag -a scalper-final 65988db -m "last commit
  containing the 5m auto-trader"` — one command, no ongoing surface, no branch that invites commits
  (§4, §13).
- **A2 — A retired config key left in `config.json` is silently ignored, and that is accepted.** This
  is `loadConfig`'s existing behavior, not a new choice (E11, F6): no migration is needed and nothing
  breaks. The accepted cost is that a hand-added retired key has no effect and no warning. The
  alternative (unknown-key rejection) would turn the owner's current live `config.json` into a startup
  failure the moment 8c lands, which is a worse trade for a file only the owner edits. §13 keeps it on
  the table.
- **A3 — The owner's `config.json` is not edited by this change and does not need to be.** Nobody
  reads `config.json` during this work (§10), and §5.6 removes no key that the daily system requires.
  If the owner prefers a tidy file, deleting the 25 retired lines by hand is safe at any time after 8c.
- **A4 — The 54 MB of scalper walk-forward artifacts stay.** They are the only artifact-level evidence
  for E1 — the finding this spec rests on and that the daily spec cites by filename (F9). Deleting the
  proof alongside the code is the L-006 failure. If the owner wants the space, §13's ordering is
  required: inline the numbers into `specs/profit-target-roadmap.md:3-7` first, delete second, in a
  separate commit.
- **A5 — "This repo cannot place orders" means no module in `src/` or `scripts/` can, not that the
  installed SDK cannot.** `bybit-official-ts-sdk` remains a dependency because `src/bybit/rest.ts`
  needs it for reads (§10), and its `trade.createOrder` / `position.setLeverage` namespaces remain
  reachable to *new* code that imports the SDK directly. What AC-4 guarantees is that no such code
  exists and that adding it would be a visible, reviewable act rather than a one-line call to a method
  already sitting on the client the journal server builds (F3). The runtime `assertReadOnlyKey` guard
  stays as the second layer (AC-6). Removing the SDK entirely would mean hand-rolling four signed read
  endpoints — a larger change with its own risk, deferred in §13.
- **A6 — `rest.ts`'s ten unused read methods are kept rather than trimmed** (§5.3, §11). Read-only, no
  capability risk, and `getKline`/`getWalletBalance` are the obvious next reads for a chart or equity
  feature. If the owner prefers a minimal surface, §13 names the trim.
- **A7 — `tests/fixtures/apt-usdt-session-2026-09-07.json` is kept for a documentation reason, with no
  automated consumer — a state it is already in today, not one this change creates.** No file loads it
  (E23); it is the measured source of `manual.roundTripFeePercent = 0.11`, a live daily default (F10).
  Accepted cost: one fixture in `tests/` that no test loads. The alternative — deleting it and letting
  the fee default become an unsourced number — is worse. If the owner prefers `tests/` to contain only
  loaded fixtures, the correct move is to relocate it to `data/validation/` with the provenance note
  pointing at the new path, in a separate commit; deleting it is not on the table while 0.11 is live.
- **A8 — No archive of the 5m *model* is kept.** `data/model/scalping-model.json` is deleted with the
  code that loads it. The conclusion it supports (the model does not clear costs, E1/E2) lives in
  `data/validation/auc-feasibility-2026-09-08.json`, which is kept.
- **A9 — The scalper-era specs stay at their current paths with a header, not moved to
  `specs/archive/`.** Their paths are cited from `specs/daily-catalyst-manual-trading.md` and from each
  other; moving them breaks every citation for no gain (F8). Accepted cost: `specs/` lists four
  superseded documents alongside two current ones.
- **A10 — Nothing outside the repository is updated by this change.** Any scheduler entry pointing at
  `npm run start` is the owner's to remove; it will fail loudly rather than degrade (§7, §9 gate 8).
- **A11 — No pointer shim replaces `npm run start`.** npm's own "Missing script: start" plus the
  available-script list is clearer than a shim that outlives its explanation (§5.5).
- **A12 — `docs/SETUP.md` and `docs/BYBIT_INTEGRATION.md` are rewritten rather than deleted**, on the
  judgement that the daily system still needs install instructions and read-only-key guidance and that
  those two files are where a reader looks. If the owner would rather fold both into
  `docs/DAILY_WORKFLOW.md` and delete them, that is a smaller docs surface and an acceptable
  substitution for §5.8.2's first two rows; AC-22/AC-23 hold either way.
- **A13 — Phase 8 changes no number the daily system produces.** `percentile` moves byte-identically
  (AC-3), so every Gate D0/D1 artifact computed before and after must agree. If any
  `backtest-daily` expectation moves, that is a bug in 8a, not a new baseline.

---

## 13. Considered alternatives (deferred or rejected)

- **Keep the engine dormant** (drop `start`/`dashboard`, leave `src/strategy/`, `src/main.ts` and the
  284 tests in place). **Rejected**, §4: it keeps every cost — a third of the test suite, 90% of its
  runtime, 25 dead config keys, the stale docs, and `placeOrder` compiled and tested — in exchange for
  an easier revert that `git` already provides (§3 P4). It also creates a class of code the repo has no
  rule for: typechecked, tested, nobody's product.
- **Archive branch `legacy/scalper-5m` before deleting.** **Rejected**, §4: history already holds every
  byte; a branch is a second thing to remember, invites "just patch it on the archive branch", and an
  archive branch that still compiles still contains the order path. **Deferred substitute if the owner
  wants a label:** an annotated tag on `65988db` (§12 A1).
- **Keep the 5m engine as a reusable strategy library** (`src/strategy/` minus `main.ts`, as a
  backtesting toolkit for future strategies). **Deferred, and on current evidence not worth taking up.**
  The concrete objection: the library is not horizon-neutral. `src/strategy/candles.ts:15` hard-codes
  `DEFAULT_INTERVAL_MS = 5 * 60_000` "matching the trained model"; `src/strategy/model.ts` loads
  5m-trained weights; `src/strategy/backtest.ts`'s fill model is built around 5m bars and post-only
  rest times measured in seconds (`src/config.ts:162-171` notes 5000 ms is 1.7% of a 5-minute bar).
  The daily system already has its own simulator with daily/hourly semantics, stop-first intrabar
  resolution and per-row funding (`src/backtest-daily/simulate.ts`, `specs/daily-catalyst-manual-trading.md`
  §5.10a). Keeping a second, differently-calibrated backtester invites the two to disagree on the same
  trade. If a future spec wants ATR or RSI at a daily interval, the cheap path is
  `git show 65988db:src/strategy/indicators.ts` and a fresh, daily-tested implementation under
  `src/research/features.ts` — not a live dependency on 5m-shaped code.
- **Move the scalper to a separate repository.** **Deferred**. It preserves the code as a runnable
  project rather than as history, which is the only thing this option buys over a tag. The costs are
  real: a second repo to keep compiling against Node and SDK upgrades, a duplicated `src/bybit/` and
  `src/config.ts`, and a second place where `placeOrder` exists. For a strategy with a confirmed
  negative edge (E1) and no user, that is maintenance for an artifact nobody will run. Revisit only if
  the owner wants to *develop* the 5m strategy again, in which case the extraction starts from
  `65988db` and is its own spec.
- **Trim `rest.ts` down to the four read methods the daily system actually calls** (§12 A6). **Deferred**
  to a follow-up if the owner wants the minimal surface. Not taken here because it is ten more
  deletions with no capability argument behind them, and it would delete `getKline`/`getWalletBalance`
  — the two most likely next reads for a chart or equity feature — at the moment the repo is least
  sure what it wants next. §3 P2 says keep when unsure.
- **Drop `bybit-official-ts-sdk` entirely** and hand-roll the four signed read endpoints with `fetch`.
  **Deferred**: it would make A5's claim absolute (no order-capable code anywhere in the dependency
  tree), but it replaces a maintained, tested client with hand-written V5 request signing, which is
  exactly the kind of security-relevant code this repo should not be writing to win a rhetorical
  point. Revisit only if the SDK becomes unmaintained.
- **Add unknown-key rejection to `loadConfig`** so a retired key becomes a loud startup error rather
  than a silent no-op (§12 A2). **Deferred**: it turns the owner's current live `config.json` — which
  contains all 25 retired keys — into a startup failure the moment 8c lands, and it would need its own
  migration path. The better-shaped version is a *warning* on unrecognized keys rather than a throw,
  which is a small standalone change with its own AC and no interaction with this deletion.
- **Delete the 54 MB of walk-forward artifacts in this change** (F9, §12 A4). **Rejected in this
  ordering, available in another.** The evidence for deleting the scalper cannot be deleted in the
  commit that deletes the scalper. The honest sequence, if the owner wants the space, is: (1) inline
  E1's numbers — median R/day, folds positive, p-value, per-symbol results — as a table in
  `specs/profit-target-roadmap.md:3-7` and update the daily spec's E1 citation to point at that table
  instead of the file; (2) delete the four `walk-forward-*.json` files in a separate commit whose
  message names the table that replaced them. Then the claim survives its artifact.
- **Delete `docs/SETUP.md` and `docs/BYBIT_INTEGRATION.md` instead of rewriting them**, folding what
  survives into `docs/DAILY_WORKFLOW.md` (§12 A12). **Available as a substitution**, not the default:
  a reader looking for "how do I set this up" looks for `SETUP.md`, and `DAILY_WORKFLOW.md` is already
  638 lines.
- **Add a graceful-shutdown handler to the journal server** so `npm run journal` exits 0 on `SIGINT`
  instead of dying to the signal (AC-19, §11). **Deferred** — it is a genuine small improvement (an
  in-flight exchange sync is currently cut mid-request on Ctrl+C, and a `writeSyncStatus` could be
  left unwritten), but it is a daily-system behavior change with its own acceptance criteria, and
  putting it in the deletion commit is how a retirement turns into a refactor. Worth its own
  three-line change whenever someone is next in that file.
- **Do Phase 8 as one commit instead of four.** **Rejected**, §3 P3: the four-way split is what makes
  each `npm run verify` meaningful and what makes a `tsc` failure localize to a wrong claim in §5
  rather than to "something in a 72-file diff". It also keeps the F3 window (no auto-trader, order
  methods still present) explicit and short rather than invisible inside a squash.
- **Leave the docs for a later pass** (ship 8a–8c, defer 8d). **Rejected**, §8 go/no-go and F7: the
  docs half is the half that reaches every future agent, and an `AGENTS.md` that documents an order
  path in a repo that no longer has one is worse than the code deletion is good.
