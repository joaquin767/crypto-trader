# Live Trading Readiness — Financial Logic Spec v1

Status: **REVIEWED (self-review + independent adversarial agent review, both incorporated) — Phase 1 implementation starting**
Owner: crypto-trader financial core (portfolio, risk, execution, Bybit integration)
Purpose: define what must change before this system operates **real capital**, in priority
order, with concrete acceptance criteria. This spec is the audit + the plan; it supersedes
the risk/execution claims in `docs/RISK_MANAGEMENT.md` and `docs/BYBIT_INTEGRATION.md`
where they conflict with what's written here (those docs get updated once each phase ships).

---

## 0. How to read this document

- **§1** is the audit: what's true about the code today, organized by severity. Every claim
  cites the file/line it's based on. This is the "why" for everything after it.
- **§2** is design principles for the rewrite — the invariants every subsequent section must
  satisfy.
- **§3–§10** are the per-subsystem specs: target behavior, data shapes, acceptance criteria.
- **§11** is the phased rollout plan (P0/P1/P2/P3) — this is the actual build order.
- **§12** is the testing strategy.
- **§13** is open questions that need a decision before or during implementation.

Severity levels used throughout:
- **P0 — blocks any live run with real money.** Correctness/safety bugs that can lose money
  in ways the user did not consent to, independent of strategy quality.
- **P1 — blocks scaling past a small pilot.** Would surface as real problems once capital or
  symbol count grows, but survivable at "beginner" scale from `docs/RISK_MANAGEMENT.md`.
- **P2 — hardening.** Correctness/robustness gaps that matter for a production system but
  aren't acutely dangerous at small scale.
- **P3 — improvement.** Quality/accuracy issues (naming, realism) worth fixing but not risk.

---

## 1. Audit of the current system

### 1.1 — P0 findings

#### F1. The bot trades leveraged perpetual futures, but every safety claim in the docs and UI assumes spot-like 1:1 exposure

`BybitConnector` hardcodes `category: "linear"` everywhere (`src/bybit/connector.ts:214,301,396,448`)
— that's Bybit's USDT-margined **perpetual futures** product, not spot. Nowhere in the
codebase does the bot call `POST /v5/position/set-leverage`, read back the account's
configured leverage, or set margin mode (isolated vs. cross). `BybitPosition.leverage` and
`BybitPosition.liquidationPrice` are parsed from the API (`src/bybit/types.ts:129-130`) but
**never read anywhere else in the codebase** — grep confirms zero other references.

This means:
- Actual leverage is whatever was last set manually on the Bybit account (or Bybit's
  product default) — the bot has no idea what it is and never surfaces it.
- `calcPositionSize()` and the cash guardrail (`portfolio.ts`) both assume `positionUsd`
  dollars of notional = `positionUsd` dollars of capital at risk. On a leveraged perpetual,
  margin used = notional / leverage — the actual capital consumed and the actual liquidation
  risk are **both invisible to the code that's supposed to be the cash guardrail.**
- `docs/RISK_MANAGEMENT.md` promises "the system NEVER exceeds `maxCapitalUsd`" and frames
  this purely in dollar-notional terms — true for the ledger the bot keeps, false for the
  real risk on the exchange, because a liquidation can wipe a position for more than the
  notional the bot thinks it spent if leverage is high and margin mode is cross (cross margin
  can draw down the whole account, not just the position's allocated margin).
- No liquidation-price monitoring exists anywhere. A position could be minutes from
  liquidation and the dashboard would show nothing about it.

**Recommendation (see §13.1 for the alternative and why it's deferred):** rather than
migrating the product type — which would also gut the position/reconciliation model this
session just hardened (`reconcilePositions()`, `BybitPosition`, drift monitoring all assume
a perpetual "position"; spot has no position concept, only wallet balances, so "switch to
spot" is a much larger rewrite than the category string) — **neutralize the leverage risk on
the current product**: pin leverage to 1x and margin mode to isolated at startup (§3.1),
verified, refuse to start otherwise. This closes the actual danger (unbounded leverage,
account-wide cross-margin exposure) with a small, surgical, verifiable change instead of a
rewrite, and keeps it in Phase 1. Full spot-mode support remains on the table as a larger,
separate future project (§13.1) — not a Phase 1 blocker.

#### F2. Closing orders never set `reduceOnly` — a desync can open a naked short instead of failing safely

`RestClient.placeOrder()` is called from `BybitConnector.placeOrder()`
(`src/bybit/connector.ts:394-403`) with `reduceOnly: false` hardcoded, for **both** buy and
sell signals. `BybitOrderRequest.reduceOnly` exists in the type (`src/bybit/types.ts:86`) and
is wired end-to-end through the REST layer — it's simply never set to `true`.

Local position tracking has already been observed, in this repo's own session logs, to
desync from the exchange (`[bybit] Position drift: Bybit reports an open SOL/USDT position
... not tracked locally`, and the `reconcilePositions()` "unaccounted-for" warnings added
this session). If a sell signal fires while local state still believes a position is open
but the exchange no longer has it (already closed manually, liquidated, or the original buy
fill was never actually confirmed), the market sell order **opens a new short position**
instead of erroring — on a leveraged product, with real capital.

This is independently true regardless of the spot-vs-perp decision in F1 (spot can't go
short, but selling more spot than is actually held is a hard exchange rejection either way —
`reduceOnly` matters specifically once/if perpetuals are kept, and costs nothing if spot is
the default, so it belongs in P0 regardless).

#### F3. Quantity rounding can round a sell UP past the actually-held size

`BybitConnector.validateQty()` (`src/bybit/connector.ts:334-348`) does
`Math.round(qty / qtyStep) * qtyStep` for every order — buys and sells alike. For a sell
closing a position, if the position's tracked quantity isn't an exact multiple of `qtyStep`
(routine after float arithmetic through several buy/fee/reconcile operations), rounding
**up** attempts to sell more than is actually held. Combined with F2, this is the concrete
mechanism by which a "close my position" sell becomes "close my position and open a new
short for the difference."

#### F4. Paper-mode and Bybit-fallback trades are priced with `40000 + Math.random() * 2000`, independent of the real symbol or price

`src/executor.ts:42` (`execute()`) and `src/market.ts:35` (`watch()`) both fabricate a price
in the $40,000–$42,000 range **regardless of which symbol is being traded** — a SOL/USDT
"paper buy" is priced as if SOL were $41,000.

This isn't only a demo-mode cosmetic issue: `execute()` is also the **fallback path** that
runs live, mid-session, after a real Bybit connection hits `BybitInsufficientBalanceError` or
`BybitInvalidQtyError` (`src/main.ts:188,198`) — i.e., real trading silently degrades into
fabricated-price trading, and those fabricated trades get written to the same
`recordEntry()`/`recordExit()` journal (`src/main.ts:242-245`) that feeds the performance
analyzer and the learning optimizer that adjusts live strategy parameters. Fantasy trades at
a fantasy price are indistinguishable, in the journal and in the dashboard's win-rate and
P&L numbers, from real fills.

**This is worse than a data-quality problem — it can silently abandon a real, still-open
leveraged position.** Trace the actual fallback path for a *sell*: `main.ts:182-198` calls
`bybit.disconnect()` as part of the fallback, **before** calling `execute()` — so no real
closing order is ever sent to Bybit. `executor.ts:43` then fabricates not just a fake price
but, for a sell, a **hardcoded quantity of `0.01`** regardless of what's actually held.
`portfolio.ts:96-98` (the `update()` "sell" branch) ignores `trade.quantity` entirely and
always removes **100%** of the locally-tracked position, crediting cash based on the local
quantity at the fantasy price. Net effect: the bot's own books show the position closed and
cash credited; the real leveraged position **stays open and unmanaged on Bybit**, and because
the bot now believes it holds nothing for that symbol, `signals.ts`'s stop-loss/take-profit
check never runs for it again. A real position can be left to ride, unmonitored, indefinitely.

#### F5. No portfolio-level circuit breaker — confirmed as a known, documented gap

`docs/RISK_MANAGEMENT.md:115` states outright: *"The system does NOT have a hard 'stop-loss
on total capital.' You are responsible for monitoring the dashboard and stopping if losses
exceed your comfort level."* Grep of `src/` confirms: no daily-loss check, no drawdown-based
halt, no consecutive-loss halt, anywhere in the trading cycle
(`src/main.ts:runTradingCycle`). The only halt condition that exists today is `fatalHalt`,
triggered exclusively by a `BybitFatalError` (account ban/restriction) — strategy losses,
however severe, never stop the bot.

For a system whose entire premise is "you decide the cap, we never exceed it," having *no*
automated response to a strategy actively losing money inside that cap is the single biggest
gap between the documented promise and actual behavior.

#### F6. Duplicate-instance protection does not exist

Nothing prevents the same `config.json` (same API key, same account) from being started by
two separate processes — e.g. exactly what happened in this session, where a background dev
server from an earlier turn was still running when a second instance was started. Two
unsynchronized local portfolios trading against one real account is a direct path to
uncontrolled, doubled risk exposure and an unreconcilable journal.

#### F7. `loadConfig()` silently drops any config field it doesn't explicitly list

Already found and fixed once this session (`autoSelectSymbols` was missing from the
hand-picked field list in `src/config.ts`, so it silently defaulted to `undefined` no matter
what `config.json` said — no error, no warning, the feature was just inert). The pattern that
caused this — an explicit allowlist of fields copied one by one, with the `Config` interface
and the parser able to drift apart silently — has no test that would catch the *next*
instance of the same mistake. For a system whose entire safety model is "you set the
guardrails in `config.json`," a config field that's silently ignored is a P0-class category
of bug, not a one-off.

### 1.2 — P1 findings

#### F8. Position sizing ignores volatility — the exact same dollar exposure regardless of how risky the symbol is

`calcPositionSize()` (`src/strategy/risk.ts:12-31`) sizes purely from cash and a
confidence-derived fraction, capped at `maxPositionSizeUsd`. It does not look at the
symbol's ATR, its distance to the configured stop-loss, or anything about how much that
`positionUsd` can actually lose before the stop triggers. A stable major pair and a thin,
volatile micro-cap (exactly the kind `autoSelectSymbols` now actively picks, per this
session's fix) get identical dollar sizing for the same confidence score, even though their
real risk-of-ruin per trade is very different.

#### F9. No correlation or concentration limit across auto-selected symbols

`recommendSymbols()` (`src/strategy/symbol-recommender.ts`) picks the top-N symbols purely
by affordability/liquidity score — there's no check on whether the selected symbols are
highly correlated (e.g., several low-cap alts that move together in a broad selloff). The
"diversification" implied by holding multiple positions can be illusory.

#### F10. Partial fills are not tracked — only "fully filled" or "poll again"

`orderResponseToTradeResult()` throws `BybitFillUncertainError` on anything that doesn't
parse to real numbers, and `BybitConnector.pollForFill()` only accepts a match where
`orderStatus === "Filled"` (`src/bybit/connector.ts:426-432`) — `"PartiallyFilled"` (a real,
documented `BybitOrderStatus`, `src/bybit/types.ts:94`) is never specifically handled. If a
market order partially fills and then stalls (realistic on a thin micro-cap book), the poll
loop gives up after 4 attempts and surfaces `BybitFillUncertainError` — but the partial
quantity that **did** fill is now real exchange exposure with zero local record of it.

#### F11. Trade journal is a single unguarded JSON file with no atomicity or backup

`src/learning/journal.ts:52` calls `writeFileSync` directly on every trade — a crash mid-write
corrupts the file, there's no backup/rotation, and (demonstrated this session, by the
assistant) an accidental `rm` of the file permanently erases the local record of every open
position with no recovery path (the system explicitly and correctly refuses to auto-adopt
unrecognized exchange positions — see `reconcilePositions()` — which is the right call for
*unknown* positions, but there's no path to recover a *known* position's local record once
lost).

#### F12. Wallet balance is fetched once and never reconciled again

`dashboardState.walletTotalUsd` is initialized to `config.maxCapitalUsd`
(`src/main.ts:86`) and never updated after that in the live loop — `getWalletBalance()`
exists on the REST client but has no caller in `main.ts`. This is fine as "display only, not
operating capital" by explicit design (`adapters.ts:100`), but with nothing periodically
checking it, the user has zero automated warning if the real account balance can no longer
support what the bot believes its operating capital is (manual withdrawal, funding payments,
other manual trades on the same account).

#### F13. Funding rate (real P&L on a perpetual) is parsed but never accounted for

`BybitTicker.fundingRate` exists in the type (`src/bybit/types.ts:49`) but nothing in the
codebase reads it. Perpetual funding payments settle every 8h and are real, sometimes
material P&L that is completely invisible to the journal, the analyzer, and therefore the
learning optimizer, which is tuning strategy parameters off an incomplete P&L signal. This
finding is moot if F1 resolves to spot-as-default, and becomes P0 if perpetuals stay.

### 1.3 — P2 findings

#### F14. All money/quantity math is IEEE-754 `number`, with ad hoc rounding scattered per call site

There's no central rounding/precision helper. `toFixed(4)` is hardcoded in the "quantity too
small" branch of `placeOrder()` (`src/bybit/connector.ts:363`) regardless of the symbol's
actual `qtyStep` decimal precision, which can format an invalid quantity string for a symbol
needing more or fewer decimals. At current small-USD scale this is unlikely to matter for
raw float error, but the formatting bug is real today, and it's the same code path as F3.

#### F15. No crash-recovery for an order that was sent but never confirmed locally

If the process dies between `rest.placeOrder()` returning and `recordEntry()`/
`portfolio.update()` running, a real fill can exist on the exchange with no local record at
all until the next startup's `reconcilePositions()` — which, by design (correctly, for
*unrecognized* positions), refuses to adopt it into auto-trading and only surfaces a warning.
There's no "pending order" durable record that a restart could use to specifically recover
*this* trade rather than generically flag an unaccounted-for position.

#### F16. No dry-run / shadow mode against live market data before flipping to `--live`

Testnet is the only pre-mainnet validation path, and testnet liquidity/spreads are not
representative of mainnet. There's no way to run the real decision engine against real
mainnet market data, logging what it *would* trade, without actually placing orders.

### 1.4 — P3 findings

#### F17. "Kelly Criterion" is a misnomer for what the code does

`calcPositionSize()` uses `max(0, (confidence - 0.5) * 2)` as a stand-in "Kelly fraction" —
there's no win probability or payoff ratio involved, which is the entire basis of the actual
Kelly formula. This is doubly avoidable because the learning system already tracks real
`winRate`/`avgWin`/`avgLoss` per symbol (`analyzer.ts`) — the ingredients for genuine
fractional-Kelly sizing already exist and aren't used for sizing at all today.

---

## 2. Design principles for the rewrite

Every section from §3 onward must satisfy these. They're the acceptance bar, not aspirations.

1. **The exchange is the source of truth for positions; the local journal is the source of
   truth for cost-basis and strategy attribution.** On any conflict, exchange state wins for
   "what do I hold," and the journal is corrected to match — never the reverse.
2. **Fail closed, not open.** Any ambiguous state (unconfirmed fill, unreachable exchange,
   corrupted local file, config that doesn't parse cleanly) halts new position-opening trades.
   It never silently substitutes fabricated data to keep going.
3. **A dollar of notional the bot places must equal a dollar of capital the user configured
   it to risk.** No hidden leverage, no silent product-type assumptions.
4. **Every automatic safety action is loud.** A halt, a rejected trade, a reconciliation
   correction — all of these are ERROR-level logged, dashboarded, and require a human to
   clear before the affected symbol resumes auto-trading.
5. **Paper/simulated and real trades are never mixed in a way that can't be told apart** —
   not in the journal, not in performance metrics, not in what feeds the learning optimizer.
6. **No feature is "on" by config unless the parser actually reads that field** — config
   parsing gets a test that makes this structurally impossible to get wrong silently again.

---

## 3. Capital, leverage, and product-type guardrails (P0)

### 3.1 Pin leverage to 1x and margin mode to isolated — verified, not assumed

On connect, `BybitConnector` calls `position.setLeverage({category: "linear", symbol,
buyLeverage: "1", sellLeverage: "1"})` for every configured symbol, and
`account.setMarginMode({setMarginMode: "ISOLATED_MARGIN"})` once for the account (both SDK
methods confirmed to exist: `PositionService.setLeverage`, `AccountService.setMarginMode` —
Bybit's V5 API sets margin mode account-wide for Unified Trading Accounts, not per-symbol, so
this is one call, not one per symbol). Read back `getPositionInfo` afterward and confirm
`leverage === "1"` for each symbol before allowing any trading to start; refuse to start
(same severity as `fatalHalt`) if it can't be confirmed. This refusal gate is built and
enforced in Phase 1 — it is what makes leverage pinning an actual guarantee rather than a
best-effort startup call; nothing in Phase 2 or later re-implements or relaxes it.

Two integration subtleties, both must be handled explicitly rather than left to "any error
means refuse to start":

- **Already-pinned is not an error.** Calling `setLeverage` when the value already matches is
  expected to be the steady state after the first successful run, and Bybit's V5 API returns
  a specific "leverage not modified" rejection for this case (verify the exact retCode against
  current Bybit docs at implementation time — do not hardcode a guessed value). That specific
  response must be treated as success, confirmed by the `getPositionInfo` read-back exactly
  like a fresh pin — otherwise the bot would refuse to start on every restart after the first
  one that actually worked.
- **An open position can block the change.** Bybit rejects leverage/margin-mode changes while
  a position is already open in a different configuration — which matters directly because
  this codebase already supports recovering an open position from a prior session
  (`reconstructPortfolio()`, `reconcilePositions()`). If restart finds an open position at the
  wrong leverage/margin, the correct behavior is **not** to loop or hard-refuse-and-exit
  (that would strand a real position on the exchange with nothing running to manage it) — it's
  to read that position's actual leverage/margin directly via `getPositionInfo` (skip the
  `setLeverage` call for that specific symbol), allow the bot to start with closing-only
  management of that one position (stop-loss/take-profit/liquidation-buffer monitoring all
  stay active for it), and loudly flag it as "opened outside the 1x/isolated guarantee —
  closing only" so the user can decide whether to close it manually. New entries for that
  symbol stay blocked until it's flat and the pin succeeds normally.

This is smaller than a spot-mode migration — it doesn't touch the position/reconciliation
model — but it is not a one-line change either; both cases above are load-bearing, not edge
polish. It closes the actual danger this section exists for: unbounded leverage amplifying
position size beyond what `maxCapitalUsd` accounts for, and cross-margin exposure that isn't
bounded by any single position's allocated capital. At 1x isolated, `quantity * price`
(notional) and margin used
converge to the same number, which is what `portfolio.ts`'s cash guardrail has assumed all
along; the guardrail code itself needs no change once this is true.

### 3.2 Liquidation monitoring stays on regardless

Even at 1x isolated, a position can still be liquidated (isolated margin is bounded, not
zero-risk) — `BybitPosition.liquidationPrice` is read on every position poll and surfaced on
the dashboard. A position within a configurable buffer (default 15%) of its liquidation price
triggers an immediate halt-and-alert for that symbol, independent of the stop-loss logic in
`signals.ts` (the stop-loss check runs once per `refreshIntervalMs`; the liquidation buffer
should be checked on every tick where price data changes, since liquidation is unforgiving
and 1x leverage does not make it impossible, only far less likely).

### 3.3 Funding rate is accounted for

Funding payments (`fundingRate` × notional, settled every 8h per Bybit's schedule) are
fetched and recorded as journal entries distinct from trade P&L, and rolled into the
performance analyzer's `totalPnl` — otherwise the learning optimizer keeps tuning strategy
parameters off a P&L number that's silently missing a real, recurring cost/credit.

### 3.4 Cash guardrail gets a belt-and-suspenders assertion — checked continuously, not just at connect

`portfolio.ts`'s `create()`/`update()`/`canAfford()` logic does not need to change. Add one
additional check: assert that for every exchange position, `BybitPosition.leverage` (already
present on every position payload — `types.ts:130`) equals `"1"`. A mismatch means leverage or
margin mode drifted from what was confirmed at startup (e.g., changed manually on the Bybit
app mid-session) — halt that symbol immediately rather than continue trading against an
assumption that's silently stopped being true.

`reconcilePositions()` is currently called from exactly one place in the whole codebase
(`main.ts`, once, right after `connect()`) — an assertion that only runs there would not
catch mid-session drift at all, which is precisely the scenario this check exists for. Wire
it into the **existing** `bybit.onPosition()` handler instead (`main.ts`'s WS-driven
position-drift callback, which already fires on every position update pushed by Bybit's
private WebSocket stream — near-real-time, no new polling needed): today that handler only
compares quantity and logs a warning; extend it to also compare `leverage`, and make a
leverage mismatch specifically escalate to a halt for that symbol (quantity drift stays a
warning, handled by reconciliation, per existing design — leverage drift is a direct
violation of this section's safety invariant and gets the stricter response).

### 3.5 (Future, not Phase 1) Spot mode as an alternative

A `market: "spot" | "perpetual"` config option, with the connector, adapters, position
reconciliation, and symbol recommender all reworked around spot wallet balances instead of
perpetual positions, remains a valid longer-term direction — it removes leverage/liquidation
risk categorically rather than bounding it. It is **not** scoped into this phased plan because
it is materially larger than every other Phase 1–3 item combined (see §13.1): it changes what
a "position" means throughout the codebase, not just how orders are placed. Tracked as a
future initiative, not a blocker.

---

## 4. Order execution & exchange semantics (P0, except §4.3 which is P1 — see §11)

### 4.1 `reduceOnly` on every closing order

`BybitConnector.placeOrder()` takes an explicit `intent: "open" | "close"` parameter (derived
by the caller in `main.ts` from whether this is a new position or closing an existing one —
that information already exists at the call site). `intent: "close"` always sets
`reduceOnly: true`. A `reduceOnly` rejection from the exchange is treated as authoritative:
the local position is wrong, trigger `reconcilePositions()` immediately rather than retrying
the sell.

### 4.2 Sell quantity never exceeds the exchange-confirmed held quantity

`validateQty()` takes a `side` parameter. For `side === "sell"` closing a position, round
**down** (`Math.floor`) to the nearest `qtyStep`, and additionally clamp to the last
`reconcilePositions()`-confirmed exchange quantity for that symbol, not the locally-tracked
quantity, if the two differ. Buys keep the existing round-to-nearest behavior (rounding up on
a buy costs a few extra cents of notional, not a phantom short).

### 4.3 Partial fills are tracked, not discarded

`pollForFill()` accepts `orderStatus === "PartiallyFilled"` as a valid (if incomplete)
intermediate result — but it must **not** call `recordEntry()`/`portfolio.update()` once per
partial fill. `portfolio.ts`'s `update()` has no same-symbol merge logic (`"buy"` always
appends a new `Position`; `"sell"` always removes 100% of the existing one) — calling it twice
for one logical order would create two `Position` rows for the same symbol, and every
`positions.find(p => p.symbol === ...)` lookup in `signals.ts`/`main.ts` only ever sees the
first, silently orphaning the second from stop-loss/take-profit management. Instead:
**accumulate** partial fills in the poll loop itself (track `cumExecQty`/weighted-average
`avgPrice`/summed `cumExecFee`, which Bybit's order response already reports as running
totals — no local summing needed) and call `recordEntry()`/`portfolio.update()` **exactly
once**, either when `orderStatus === "Filled"` or when the poll window is exhausted with a
non-zero partial (`cumExecQty > 0`) — in the latter case, journal exactly what filled and
surface the remainder (`leavesQty`) as a distinct warning, never as a second trade.

### 4.4 Quantity/price formatting is centralized

One `formatQty(symbol, qty, {roundDirection})` and `formatPrice(symbol, price)` helper, driven
by the cached `qtyStep`/`tickSize` for that symbol, used by every call site that currently
does its own `toFixed(n)`. No call site hardcodes a decimal count.

---

## 5. Portfolio-level circuit breakers (P0)

New module `src/risk/circuit-breaker.ts`. Evaluated once per trading cycle, before any new
position-opening trade is allowed (closing/stop-loss trades are never blocked — a circuit
breaker must never prevent the system from *reducing* risk, only from *adding* it):

| Trigger | Default threshold | Config field | Action |
|---|---|---|---|
| Daily loss | 10% of `maxCapitalUsd` from the day's opening equity | `maxDailyLossPercent` | Halt new entries for the rest of the UTC day |
| Drawdown from peak equity | 20% | `maxDrawdownHaltPercent` | Halt new entries until manually resumed |
| Consecutive losing trades | 5 | `maxConsecutiveLosses` | Halt new entries until manually resumed |
| Fill-price anomaly | fill price >2% away from last known market price at signal time | `maxSlippagePercent` | Reject that fill from auto-continuation, halt the symbol, surface for manual review |

- All four are independently configurable and independently disable-able (explicit
  `false`, not just a large number) for users who want to opt out with eyes open — but the
  default `config.template.json` ships with all four **on**, at the thresholds above, which
  match the "$50-100 beginner" defaults already in `docs/RISK_MANAGEMENT.md`.
- A halt is a first-class dashboard state (`circuitBreakerTripped: { trigger, at, details }`),
  distinct from `bybitConnected`/`fatalHalt`, shown prominently, and requires an explicit
  resume action (dashboard button or restart) — never auto-clears on its own.
- Existing open positions still get their stop-loss/take-profit managed while a circuit
  breaker is tripped — the breaker stops new risk, it does not abandon existing risk.

---

## 6. Paper trading & fallback fidelity (P0)

### 6.1 Paper mode uses real prices

`execute()` in `executor.ts` takes the actual current `MarketSnapshot` for the signal's
symbol (already available in `main.ts`'s `latestMarketData`) instead of fabricating a price.
Fee model stays a configurable simulated percentage (documented as simulated, that part is
fine). `market.ts watch()`'s pure-simulation mode (no exchange configured at all) keeps
random-walk prices *seeded per-symbol around a realistic base* — it's clearly a demo/no-API
mode and never touches real capital, but shouldn't return the same $40k–42k range for every
symbol regardless of name (F4's cosmetic half, §1.1).

### 6.2 A live→fallback transition halts new entries only — it never disconnects, and it never fabricates a close

Today, `BybitInsufficientBalanceError`/`BybitInvalidQtyError` cause `main.ts` to call
`bybit.disconnect()` and flip `useBybit = false`, then keep "trading" via `execute()` — which
fabricates both price and (for sells) a hardcoded `0.01` quantity. Concretely, this can leave
a real, still-open leveraged position on Bybit while the bot's own books show it closed and
credit fantasy proceeds to cash — and because the connection is dropped, nothing is left
watching that position at all (see F4's expanded writeup). Fixing "don't fabricate the trade"
alone is not sufficient; the halt must preserve exactly the ability that F4 shows is currently
destroyed. Concretely:

- **Never call `bybit.disconnect()` for `BybitInsufficientBalanceError` / `BybitInvalidQtyError`.**
  The connection, the WS position feed, and `bybit.placeOrder()` all stay live — those are
  exactly what's needed to keep managing whatever the bot already holds.
- **Only new position-opening trades are blocked** for the affected symbol
  (`statusMessage`/dashboard: `⚠️ Bybit rejected the order — entries halted for {symbol},
  closes still active`). This mirrors §5's circuit-breaker rule (block opens, never blocks
  closes) — the same rule applies here, not just to §5's own triggers.
- **Stop-loss/take-profit/expert-exit sells for that symbol keep routing through
  `bybit.placeOrder()`**, never through `execute()`, for as long as a real position might
  still be open on the exchange. `execute()` is reserved exclusively for the standalone,
  explicit no-exchange paper mode (`config.exchange` unset / `"paper"`) — it must never run as
  an automatic mid-session substitute for a real order while a real Bybit position might
  exist, live or testnet.
- Resuming entries is manual (restart, or a future dashboard action per §13.3) once the user
  has fixed the underlying issue (funded the account, etc).

### 6.3 Journal entries are tagged by venue

`TradeRecord` gains `venue: "bybit-live" | "bybit-testnet" | "paper"`. The performance
analyzer and dashboard filter to the venue matching the current run by default, and any
UI/report that aggregates across venues must say so explicitly. This makes it structurally
impossible to judge live-readiness off paper numbers, or vice versa, by accident.

---

## 7. Config safety (P0)

### 7.1 Config parsing cannot silently drop fields

Replace the hand-picked field list in `loadConfig()` with a pattern that reads every key of
`Config` generically (e.g., iterate `Object.keys` of a schema/defaults object rather than
listing each field twice across the interface and the parser), OR keep the explicit list but
add a test that constructs a fully-populated raw JSON object covering every field in the
`Config` interface, calls `loadConfig`, and asserts every field round-trips — this test must
fail the moment a new `Config` field is added without a matching parser line, which is
exactly the bug this session found and fixed by hand.

### 7.2 Environment/capital sanity checks at startup

(The leverage/margin-mode refusal gate is §3.1's, built and enforced in Phase 1 — not
repeated here. The checks below are the additional ones this section owns.)

- A configurable `maxCapitalUsdWarnThreshold` (e.g. $500) — starting `--live` above it prints
  a loud warning and, in interactive mode, requires typing a confirmation phrase. This is a
  soft nudge encoding the "start small" guidance from `docs/BYBIT_INTEGRATION.md` into the
  code instead of leaving it as a documentation-only suggestion.
- Testnet vs. mainnet key mismatch detection: if `testnet: false` is set but the API key was
  clearly issued for testnet (or vice versa — Bybit's auth error for this is already
  classified as `BybitAuthError`), surface the specific likely cause instead of a generic
  auth failure.

### 7.3 Duplicate-instance lock

On startup, write a lock file keyed by a hash of `apiKey` (never the raw key) under a
well-known runtime directory, containing the PID; refuse to start if a live process already
holds that lock, with a clear error naming the conflicting PID. Released on clean shutdown;
a stale lock (dead PID) is detected and reclaimed automatically.

---

## 8. Reconciliation & journal durability (P1)

### 8.1 Atomic, backed-up journal writes

`persistJournal()` writes to a temp file in the same directory and renames over the target
(atomic on POSIX filesystems) instead of `writeFileSync` directly to the live path. Keep the
last N (e.g. 5) rotated backups (`trade-journal.json.bak.1` … `.5`) so a corrupted write or an
accidental delete (as happened this session) has a same-session recovery path.

### 8.2 Pending-order durability

Before sending `placeOrder`, persist a minimal "pending order" record (`orderLinkId`, symbol,
intent, expected qty/side, timestamp) to a small durable log. On startup,
`reconcilePositions()` cross-references any pending records against `getOrderHistory()` —
if a pending order's `orderLinkId` shows up as filled on the exchange but has no matching
journal entry, that's enough information to reconstruct the exact trade (not just flag a
generic "unaccounted-for position"). Pending records are cleared once the trade result is
confirmed and journaled.

### 8.3 Wallet balance monitoring (not operating capital — a sanity check)

Periodically (e.g. every learning cycle, ~30s) fetch `getWalletBalance()` and compare
available balance against what the bot's open notional + reserved cash implies is needed. A
material, sustained shortfall (someone withdrew funds manually, a funding payment drained
margin, etc.) surfaces as a dashboard warning. This never changes `cashUsd` — per existing
design intent — it's purely an early-warning signal.

---

## 9. Risk-aware position sizing (P1)

Replace the flat confidence-scaled sizing with risk-based sizing:

```
riskUsd = maxCapitalUsd × riskPerTradePercent        // e.g. 1% of operating capital
stopDistancePercent = max(config.stopLossPercent, atrPercent × atrStopMultiplier)
positionUsd = riskUsd / (stopDistancePercent / 100)
positionUsd = min(positionUsd, maxPositionSizeUsd, availableCash × (1 - cashReservePercent))
```

`riskPerTradePercent` (default 1%, matching the "never risk more than 1-2%" guidance already
in `docs/RISK_MANAGEMENT.md:81`) and `atrStopMultiplier` are new config fields. This makes a
volatile micro-cap and a stable major pair converge on comparable *risk*, not comparable
*notional* — directly addressing F8, and it's a small, mechanical change to
`calcPositionSize()`'s signature (needs the symbol's ATR, already computed in `signals.ts`,
threaded through).

Optionally, once enough per-symbol trade history exists (`analyzer.ts` already computes
`winRateBySymbol`, `avgWin`, `avgLoss`), layer a real fractional-Kelly multiplier on top of
the risk-based base size — this also resolves F17 by making "Kelly" actually mean Kelly.

---

## 10. Concentration limits (P1)

`autoSelectSymbols` (and manual multi-symbol configs) gain a `maxConcurrentPositions` cap
(already partially possible via `maxPositionSizeUsd` × count vs `maxCapitalUsd`, but make it
explicit) and a lightweight correlation guard: track rolling price-return correlation between
concurrently-held symbols (cheap — reuse the price history already kept in `signals.ts`), and
skip opening a new position whose trailing correlation with an existing open position exceeds
a threshold (default 0.8), logging why it was skipped.

---

## 11. Phased rollout plan

This is the build order. Each phase ends with `npm run verify` green and a short manual
testnet soak (documented in §12.3) before moving to the next.

### Phase 0 — this spec
Self-review to convergence (in progress). No code changes.

### Phase 1 (P0) — required before any real-capital run
- §3.1 leverage pinned to 1x + isolated margin, verified at startup
- §3.2 liquidation-buffer monitoring
- §3.3 funding-rate accounting
- §3.4 leverage/margin drift assertion after reconciliation
- §4.1 `reduceOnly` on closes
- §4.2 sell-quantity never exceeds exchange-confirmed holding
- §6.2 live→fallback becomes a halt, not a silent mode switch
- §6.1 paper mode uses real prices
- §6.3 journal venue tagging
- §7.1 config round-trip test + fix (structural, not just the one field)
- §7.3 duplicate-instance lock

### Phase 2 (P0) — required before real-capital run
- §5 circuit breakers
- §7.2 environment/capital sanity checks at startup

### Phase 3 (P1) — safe to scale capital
- §8.1 atomic/backed-up journal
- §8.2 pending-order durability
- §8.3 wallet monitoring
- §9 risk-aware position sizing
- §10 concentration limits
- §4.3 partial-fill tracking

### Phase 4 (P2/P3) — production hardening
- §4.4 centralized quantity/price formatting
- Decimal-precision audit (F14)
- Dry-run/shadow mode (F16) — run the live decision engine against real mainnet market data,
  logging signals and sizing decisions without calling `placeOrder`, so a strategy can be
  validated against real mainnet liquidity/spreads before `--live` is ever used for real.
  Design TBD when this phase starts (needs its own short spec — mainly a matter of gating
  `bybit.placeOrder()` behind a `dryRun` flag and logging what would have been sent).
- Real-Kelly sizing overlay (F17)

**Real capital should not go live before Phase 1 and Phase 2 are both complete.** Phase 3
items are strongly recommended before increasing capital beyond the "beginner" tier in
`docs/RISK_MANAGEMENT.md`.

---

## 12. Testing strategy

### 12.1 Every P0 item gets a regression test that fails on the old behavior
Not just a test that the new code works — a test that would have caught the specific bug.
E.g.: a test asserting that a sell placed while local qty > exchange qty gets clamped down,
not rounded up (F3); a test asserting `loadConfig` round-trips every `Config` field (F7); a
test asserting a `BybitInsufficientBalanceError` halts rather than falling back to `execute()`
(F4/§6.2).

### 12.2 Golden-path integration test for the full order lifecycle
One test (mocked REST/WS at the boundary, real everything else) that drives: signal → size →
place order → partial fill → poll → complete fill → journal → portfolio update → reconcile on
a simulated restart. This is the test most likely to catch the *interaction* bugs between
subsystems that unit tests, however thorough, miss (most of §1's findings are exactly this
kind of interaction bug).

### 12.3 Manual testnet soak before each phase gate
Minimum 24h continuous testnet run with `autoSelectSymbols` on and at least one forced
disconnect/reconnect and one forced restart mid-position, before that phase is considered
done. Document the run (start/end time, symbols traded, any manual interventions) in
`specs/soak-log.md` (create when Phase 1 testing starts).

### 12.4 Self-review pattern for implementation
Each phase's changes go through: implement → `npm run verify` → targeted manual test of the
new behavior → a self-review pass (re-read the diff cold, specifically hunting for the
"looks right but isn't" class of bug the P0 findings in this doc are made of) → commit. For
anything touching order placement or the circuit breaker, a second adversarial review pass
(spawned review agent or `/code-review`) before merging, mirroring how this spec itself is
being reviewed before implementation starts.

---

## 13. Open questions (need a decision, not just an implementation)

### 13.1 Spot as a future alternative to leverage-pinned perpetuals
This spec's Phase 1/2 plan keeps the current product (Bybit USDT perpetuals) but neutralizes
its leverage risk via §3.1 (pinned 1x + isolated margin) rather than migrating to spot. That's
the pragmatic near-term path — it's a small, verifiable change instead of a rewrite of the
position/reconciliation model. If a genuinely spot-only, leverage-free system is wanted later
(categorically removing liquidation risk rather than bounding it), that's a separate,
larger initiative: `BybitConnector`, `adapters.ts` (`bybitPositionToPosition` has no spot
equivalent — spot "holdings" come from wallet balances, not `getPositionInfo`),
`reconcilePositions()`, and `symbol-recommender.ts` (`getInstruments("linear")` →
`getInstruments("spot")` has a different response shape) would all need rework. Worth
scoping as its own spec if/when prioritized — not folded into this one.

### 13.2 Risk-per-trade default
§9 proposes 1% of `maxCapitalUsd` per trade, matching existing docs guidance. Confirm this is
the right default vs. e.g. tying it to the "beginner/intermediate/advanced" tiers already in
`docs/RISK_MANAGEMENT.md`.

### 13.3 What "resume after circuit breaker" requires
§5 says resuming requires an explicit action. Decide whether that's a dashboard button (needs
a new authenticated-ish action path — currently the dashboard is read-only/SSE, no mutating
endpoints exist at all) or strictly a process restart for v1 (simpler, no new attack surface,
but means a tripped breaker takes the whole bot down, not just new entries, unless open
positions still need active stop-loss management — which they do, per §5's last bullet, so a
pure restart-to-resume can't just kill the process). Leaning toward: a restart clears the
breaker (simplest, no new mutating dashboard surface) but the process itself keeps managing
existing positions' stop-loss/take-profit while tripped, only blocking new entries — no new
dashboard control needed for v1.

### 13.4 Multi-symbol daily-loss attribution
§5's daily loss trigger is portfolio-wide. Decide if a single very volatile symbol should be
able to trip it alone (probably yes, that's the point) vs. wanting a secondary
per-symbol daily-loss cap too (probably P2 if wanted at all).
