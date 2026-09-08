# Strategy Signal Quality — Audit & Hardening Spec

> **Accepted** by the spec-factory skill (rubric v2, round 1: 21/24 → 3 fixes applied → round 2:
> 23/24, no dimension at 0). Two further citation-accuracy corrections (an RSI value and a loss
> count, both caught by round 2's independent verification) were applied after acceptance and not
> re-scored by a third round — see git history / the fixes noted inline in §1.1 if auditing this
> further. Ready to hand to implementation; no code has been written against it yet.

Status: **Spec accepted — implementation (Phase 1) not yet started**
Owner: crypto-trader strategy engine (`src/strategy/indicators.ts`, `src/strategy/signals.ts`,
`src/strategy/risk.ts`)
Purpose: `specs/live-trading-readiness.md` made the *execution* layer safe (leverage pinned,
circuit breakers, atomic journal, reconciliation). It explicitly did not audit whether the
**strategy itself** makes money net of costs. This spec does that: it is triggered by a live
testnet session (2026-09-07) in which the auto-selected symbol (APT/USDT) lost on nearly every
one of 22 consecutive closed trades, and traces the losses to a specific, fixable mechanism in
the signal-generation code rather than "bad luck" or "a bad symbol." Nothing here should go live
with real capital, and no future indicator/threshold change should be trusted, until Phase 1 and
Phase 2 below are both done (see the Phased rollout plan for the exact gate).

**Evidence provenance note:** `trade-journal.json` is gitignored and rotates on every subsequent
run (`src/learning/journal.ts`) — by the time this spec was independently critiqued, the live
session that produced F1-F3 had already been overwritten. The exact 22-trade record has been
snapshotted to `tests/fixtures/apt-usdt-session-2026-09-07.json` so every citation below is
independently reproducible; §Testing strategy's regression tests load that fixture, not the live
file.

---

## 0. How to read this document
- **§1** is the audit: what's true about the strategy engine today, with every finding citing an
  exact `file:line` or an exact quoted line from the real 22-trade APT/USDT session produced this
  session (2026-09-07 ~18:56-20:38 UTC), snapshotted at
  `tests/fixtures/apt-usdt-session-2026-09-07.json` (see the provenance note above).
- **§2** is design principles the fix must satisfy.
- **§3-§6** are the per-subsystem specs.
- **Phased rollout plan** is the build order, with an explicit go/no-go gate.
- **Testing strategy**, **Out of scope**, and **Open questions** close the document.

Severity tiers (same scheme as `specs/live-trading-readiness.md`):
- **P0 — blocks trusting the strategy with any further real capital.** A mechanism that produces
  losses (or unverifiable P&L) essentially regardless of market direction.
- **P1 — blocks confidently tuning or scaling the strategy.** Real gaps that make it impossible to
  know whether a change helps or hurts before finding out live.
- **P2 — hardening.** Real quality gaps, not acutely loss-generating on their own.
- **P3 — improvement.** Worth fixing, not urgent.

---

## 1. Audit of the current strategy engine

### 1.1 — P0 findings

#### F1. Indicators are recomputed from a raw, unsmoothed rolling window every tick — RSI swings across its full 0-100 range within seconds of real trading, on price moves of a fraction of a percent

`calcRSI()` (`src/strategy/indicators.ts:41-53`) takes the last `period` (14) raw price deltas
from `history.prices` and computes `avgGain`/`avgLoss` fresh, from scratch, every single call —
there is no persisted smoothing state carried between ticks (a real Wilder RSI exponentially
smooths the running average; this implementation has no memory of the previous average at all,
only the raw window). Because `analyze()` is called once per `refreshIntervalMs` (config minimum
1000ms) and appends exactly one new price to the window each time, a single new tick fully
replaces 1/14th of the window's composition — on a real market where price moves by fractions of
a percent per tick, this makes RSI's output dominated by which 14 raw deltas happen to be in the
window, not by any real, multi-tick trend.

**Evidence, from `tests/fixtures/apt-usdt-session-2026-09-07.json`'s `indicatorsAtEntry.rsi`
field (a durable snapshot of the live trade-journal.json session — see the provenance note in
§0), all on the same symbol (APT/USDT) within roughly 90 minutes of continuous live trading:**
`100 → 83.33 → 62.5 → 50 → 62.5 → 20.0 → 50 → 20.0 → 100 → 60 → 100 → 66.67 → 0` (trade ids 1-13,
in order). `entryPrice` across these same trades moved from `0.6454` to `0.6374` — under 1.3% —
while RSI swung across effectively its entire domain repeatedly. This is not RSI reading a real
oversold/overbought condition; it's arithmetic noise from a too-small, unsmoothed window.

#### F2. The exit rule fires the instant noisy indicators cross a threshold, with zero confirmation or minimum holding period — positions round-trip in seconds

`signals.ts:136-143` ("expert exit"): `if (rsi > 70 && snapshot.price > bollinger.upper)` sells
**immediately**, on a single tick, no persistence check. Combined with F1, and with the
stop-loss/take-profit checks immediately above it (`signals.ts:116-133`, also single-tick), most
of the 22 APT/USDT trades this session opened and closed within a very short window:

| Trade id | Hold time (exit - entry) |
|---|---|
| 12 | **4.9s** |
| 3 | 8.4s |
| 4 | 14.9s |
| 10 | 12.8s |
| 11 | 24.7s |
| 22 | 27.0s |
| 9 | 36.3s |
| 5 | 45.0s |

(Computed directly from `entryTime`/`exitTime` epoch-ms fields in
`tests/fixtures/apt-usdt-session-2026-09-07.json`, ids as shown.) A strategy whose median holding
time on a majority of its trades is under a minute is not capturing a trend — it's reacting to,
and being whipsawed by, the same single-tick noise F1 describes.

#### F3. The round-trip fee is paid on almost every trade with essentially zero real price movement captured — this is a demonstrated, near-guaranteed loss mechanism, not bad luck

Look at the exact P&L on trades where `entryPrice === exitPrice` (price literally unchanged
between open and close): trade id 4, `pnl: -0.00796148`, and the fee recorded for that same trade
is `0.00796148` — identical to eight decimal places, `pnlPercent: 0`. Trade id 9: `pnl:
-0.00789254`, fee `0.00789254`, `pnlPercent: 0`. This is not "the market moved against us" — the
market did not move at all between this trade's entry and exit; **the entire loss is the
round-trip fee**, paid for capturing zero edge. All 21 closed trades in the journal lost money;
20 of those 21 losses are within a few tenths of a cent of exactly the fee amount (fee ≈0.11% of
notional per side here, so ≈0.22% round trip on ~$7.2 notional) — trade id1 is the sole exception,
where a small favorable price move nearly, but not quite, offset the fee (`pnl: -0.00012`, far
smaller than its `0.00795` fee). This is the direct, arithmetic consequence of F1+F2: when entry
and exit fire seconds apart on noise rather than a real move, the fee is close to the entire
result, and the fee is never favorable.

### 1.2 — P1 findings

#### F4. Nothing in the entry-scoring path checks whether the plausible move is even large enough to clear round-trip costs

`signals.ts:150-210` (buyScore/sellScore accumulation and the final `buyScore >= 4` /
`sellScore >= 4` decision) never references the exchange fee rate or the round-trip cost implied
by it. `grep` confirms no fee-rate constant or config field is read anywhere in `signals.ts`. A
signal can score high confidence on indicators alone while the ATR-implied plausible move is
smaller than what it costs just to open and close the position — F3's fee-bleed is not a rare
edge case, it's what happens by default any time this is true, which per §1.1 is often.

#### F5. No backtesting/replay harness exists — every indicator or threshold change ships straight to live/testnet with no offline validation

Confirmed by grep: no file under `src/` or `tests/` contains "backtest". `RestClient.getKline()`
(`src/bybit/rest.ts:128-141`, unit-tested in `tests/rest-client.test.ts:60` for the wrapper
itself) fetches real historical candles from Bybit and is **never called from any application
code** — only its own direct unit test exercises it. There is no way today to run `analyze()`
against a real historical price series and measure win rate/expectancy/profit factor before
deploying a strategy change; the only feedback loop is watching live losses accumulate, which is
exactly what triggered this spec.

### 1.3 — P2 findings

#### F6. MACD's "signal line" is a plain average of freshly-recomputed EMAs over shifting windows, not a true EMA-of-MACD — it compounds F1's noise rather than damping it

`calcMACD()` (`src/strategy/indicators.ts:57-70`) reconstructs up to 9 historical MACD values by
re-running `calcEMA()` from scratch over different trailing slices of `prices` each time
(`macdHistory.push(calcEMA(slice, 12) - calcEMA(slice, 26))`), then averages them with a plain
arithmetic mean (`macdHistory.reduce(...) / macdHistory.length`) to approximate the signal line —
a real signal line is itself an EMA (exponentially weighted, with memory), not a flat average
recomputed from scratch each call. `bullish` (used directly in entry scoring, `signals.ts:162`) is
derived by comparing against this same noisy reconstruction (`prevMacd < signalLine && macdLine >=
signalLine`), so MACD crossover detection inherits the same tick-to-tick instability as RSI.

#### F7. Entry "reason" strings can describe a directionally contradictory setup for what actually executes as a buy, because only the net score matters

Trade id 6's recorded reason: `"RSI oversold (20.0); price below lower Bollinger Band; volume
surge + downward momentum; price below SMA(20); high volatility (ATR 6.9%)"` — 3 of 5 listed
factors (downward momentum, below SMA, high-volatility penalty) are bearish-leaning by the scoring
rules in `signals.ts:170-188`, yet the trade executed as a **buy** because the RSI-oversold (+3)
and below-lower-Bollinger-Band (+2) buy points outweighed the bearish points in the net score.
Nothing in the composite score or the reason string surfaces this tension — a human (or a future
debugging session) reading the reason string would reasonably read it as a mixed/bearish setup,
not realize it drove a buy.

### 1.4 — P3 findings

#### F8. Every threshold in the scoring model is a fixed, unvalidated constant

RSI's 30/70 cutoffs, momentum's `2 < m < 15` / `m < -5` bands, the `atrPercent > 0.05` volatility
penalty, and every point-weight in `signals.ts:157-188` were never validated against historical
price data — there is no backtest harness (F5) to validate them against. This is downstream of F5:
it isn't fixable in isolation, only re-tunable once §6's harness exists.

---

## 2. Design principles for the fix

1. **A signal is not actionable until it has persisted, not just spiked.** Single-tick agreement
   between noisy indicators is not a trend — both entries and exits (except stop-loss/take-profit,
   which must never be delayed, per principle 3) require the signal to hold across multiple
   consecutive analysis cycles, or a minimum elapsed time, before it is acted on.
2. **An entry is not taken unless its plausible edge is large enough to plausibly clear round-trip
   cost.** Cost-awareness is explicit and checked before every entry, not left implicit.
3. **Fail closed, never delay a risk-reducing exit.** The persistence/min-hold gate in principle 1
   applies only to *new entries* and to the noise-prone "expert exit" rule — stop-loss and
   take-profit must keep firing on the very next tick that crosses their threshold, exactly as
   today. A gate that exists to reduce noise-driven churn must never become a gate that delays
   cutting a real loss.
4. **No strategy-logic change (indicator math, thresholds, scoring weights) ships without an
   offline backtest showing non-negative expectancy, net of realistic round-trip fees, over a real
   historical sample.** This is what turns "we think this is better" into something checked before
   it's trusted with capital again.
5. **Indicators carry state between ticks.** Recomputing from a raw window every call, with no
   memory of the previous smoothed value, is the root mechanism behind F1/F6 — the fix is
   structural (stateful, exponentially-smoothed indicators), not a threshold tweak.

---

## 3. Stateful, smoothed indicators (P0 — resolves F1, F6)

New per-symbol persisted state, following this codebase's existing pure-function convention (see
`src/risk/circuit-breaker.ts`, `src/strategy/concentration.ts`: state passed in, new state and a
result returned, no hidden mutation):

```ts
// src/strategy/indicators.ts additions

export interface RsiState {
  avgGain: number;
  avgLoss: number;
  initialized: boolean;   // false until `period` samples have been folded in
}

export const initialRsiState = (): RsiState => ({ avgGain: 0, avgLoss: 0, initialized: false });

/**
 * Wilder-smoothed RSI: exponential running average of gains/losses, carried
 * between calls, instead of recomputed from a raw trailing window each time.
 * `priceChange` is the single latest (current - previous) price delta.
 */
export function updateRsi(
  state: RsiState, priceChange: number, period = 14,
): { state: RsiState; value: number } {
  const gain = Math.max(priceChange, 0);
  const loss = Math.max(-priceChange, 0);
  if (!state.initialized) {
    return { state: { avgGain: gain, avgLoss: loss, initialized: true }, value: 50 };
  }
  const avgGain = (state.avgGain * (period - 1) + gain) / period;
  const avgLoss = (state.avgLoss * (period - 1) + loss) / period;
  const value = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  return { state: { avgGain, avgLoss, initialized: true }, value };
}

export interface MacdState {
  emaFast: number | null;  // 12-period EMA of price
  emaSlow: number | null;  // 26-period EMA of price
  signal: number | null;   // 9-period EMA of the MACD line itself
}

export const initialMacdState = (): MacdState => ({ emaFast: null, emaSlow: null, signal: null });

/** True EMA-of-EMA MACD, all three components carried as running state. */
export function updateMacd(
  state: MacdState, price: number, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9,
): { state: MacdState; result: MACDResult } {
  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);
  const kSig = 2 / (signalPeriod + 1);
  const emaFast = state.emaFast === null ? price : price * kFast + state.emaFast * (1 - kFast);
  const emaSlow = state.emaSlow === null ? price : price * kSlow + state.emaSlow * (1 - kSlow);
  const macdLine = emaFast - emaSlow;
  const signal = state.signal === null ? macdLine : macdLine * kSig + state.signal * (1 - kSig);
  const prevSignal = state.signal ?? signal;
  const histogram = macdLine - signal;
  const bullish = (state.signal !== null) && (state.emaFast! - state.emaSlow! < prevSignal) && (macdLine >= signal);
  return { state: { emaFast, emaSlow, signal }, result: { macdLine, signalLine: signal, histogram, bullish } };
}
```

`getHistory()`/`_history` in `signals.ts` gains `rsiState: RsiState` and `macdState: MacdState`
fields (initialized via `initialRsiState()`/`initialMacdState()`), updated once per tick via
`updateRsi`/`updateMacd` instead of the current from-scratch `calcRSI(history.prices, 14)` /
`calcMACD(history.prices)` calls. The existing `calcRSI`/`calcMACD` free functions stay (used
elsewhere, e.g. a backtest replaying historical bars where stateful carry-over across a
in-memory-only session doesn't apply the same way) but `analyze()` switches to the stateful path.

**Acceptance criteria:**
- [ ] Given a synthetic price series with one large one-tick spike followed by 13 unchanged
  prices, `updateRsi` does not return a value that swings across more than ~30 points from one
  call to the next once `initialized` — unlike the current `calcRSI`, which can swing the full 0-100
  range on the same input (this is the regression test for F1 — see Testing strategy).
- [ ] `updateMacd`'s `bullish` flag requires at least 2 calls with `state.signal !== null` before
  it can ever be `true` — it cannot fire on the very first tick after initialization.

---

## 4. Signal persistence and minimum holding period (P0 — resolves F2)

New config fields:

```ts
// src/config.ts additions
/** Consecutive analyze() cycles a NEW-ENTRY signal must agree before it is
 *  acted on — damps single-tick noise from becoming a real trade. Does not
 *  apply to stop-loss/take-profit (see design principle 3). Default 2. */
signalConfirmationTicks?: number;
/** Minimum ms a position must be held before the noise-prone "expert exit"
 *  rule (RSI/Bollinger-based) may close it. Stop-loss and take-profit are
 *  NEVER subject to this — a real loss is always cut immediately. Default
 *  30000 (30s), chosen to exceed the sub-minute round-trips observed in
 *  the 2026-09-07 session (see F2). */
minHoldBeforeExpertExitMs?: number;
```

`signals.ts` tracks, per symbol, a small persistence counter (added to the existing per-symbol
history state): the last N raw signal directions (buy/sell/hold, before the score threshold is
applied) and only returns a non-`hold` **new-entry** signal once the same direction has appeared
for `signalConfirmationTicks` consecutive calls. The **stop-loss and take-profit checks
(`signals.ts:116-133`) are untouched** — they must keep firing on the very next tick, per design
principle 3. The **"expert exit" check (`signals.ts:136-143`) gains a `positionAgeMs >=
minHoldBeforeExpertExitMs` guard**.

This requires a concrete interface change: `Position` (`src/portfolio.ts:3-8`) today has exactly
`{ symbol, quantity, entryPrice, currentPrice }` — confirmed by direct read, no timestamp field
exists anywhere on it or on `TradeResult` (`src/executor.ts`). Add `openedAt: number` to
`Position`:

```ts
// src/portfolio.ts — Position gains one field
export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  openedAt: number;   // Date.now() at the moment this position was opened
}
```

Populated in `portfolio.ts`'s `update()`, in the `"buy"` branch that constructs a new `Position`
(the branch that appends a new position row) — set `openedAt: trade.timestamp` (the `TradeResult`
already carries a `timestamp` field, `src/executor.ts:12`) at construction time, alongside the
other fields already assigned there. `positionAgeMs` in `signals.ts` is then simply `snapshot.
timestamp - existing.openedAt` using the existing position lookup at `signals.ts:96,111`.

**Acceptance criteria:**
- [ ] Given a symbol whose raw buy score crosses the buy threshold for exactly 1 tick then drops
  back to hold, `analyze()` returns `hold`, not `buy` — the entry is not taken (regression test for
  F2's whipsaw mechanism).
- [ ] Given the same buy condition sustained for `signalConfirmationTicks` consecutive ticks,
  `analyze()` returns `buy` on the tick where the count is reached, not before.
- [ ] Given an open position whose stop-loss condition is met 1ms after entry, `analyze()` still
  returns `sell` immediately — `minHoldBeforeExpertExitMs` has zero effect on stop-loss/take-profit.
- [ ] Given an open position younger than `minHoldBeforeExpertExitMs` whose RSI/Bollinger "expert
  exit" condition is met, `analyze()` returns `hold`, not `sell` — once older, the same condition
  does return `sell`.

---

## 5. Cost-aware entry gate (P1 — resolves F4)

```ts
// src/config.ts addition
/** Estimated round-trip (entry + exit) taker-fee cost, as a percent of
 *  notional, used only to gate entries whose plausible move can't plausibly
 *  clear costs. Default 0.22 (matches this session's live-observed ~0.11%
 *  per side on Bybit testnet). Not used for actual fee accounting — real
 *  fees always come from the exchange fill / the paper executor's own rate. */
estimatedRoundTripFeePercent?: number;

// src/strategy/risk.ts addition
/**
 * True if the ATR-implied plausible move at least clears round-trip cost by
 * `minEdgeToFeeRatio`×. A signal that fails this is a coin-flip on direction
 * with a fee that's already larger than the expected move — see F3/F4.
 */
export function hasPlausibleEdge(
  atr: number, price: number, config: Config, minEdgeToFeeRatio = 2,
): boolean {
  const atrPercent = price > 0 ? (atr / price) * 100 : 0;
  const roundTripFeePercent = config.estimatedRoundTripFeePercent ?? 0.22;
  return atrPercent >= roundTripFeePercent * minEdgeToFeeRatio;
}
```

Wired into `signals.ts`'s new-entry evaluation (§"New position evaluation", `signals.ts:152` area):
if `buyScore`/`sellScore` would otherwise cross the entry threshold but `hasPlausibleEdge()` is
false, return `hold` with reason `"insufficient plausible edge vs. round-trip cost"` instead of
entering. This never applies to closes (principle 3 again — a real position's stop-loss/take-profit
must never be gated by whether the *original* entry looked cost-effective).

**Acceptance criteria:**
- [ ] Given `atr` implying a 0.1% plausible move and the default 0.22% round-trip fee estimate,
  a signal that would otherwise score a `buy` returns `hold` instead, with the specific reason
  string above.
- [ ] Given `atr` implying a 1% plausible move under the same fee estimate, the same otherwise-buy
  signal is unaffected (still returns `buy`).

---

## 6. Backtesting harness (P1 — resolves F5, unblocks F8)

```ts
// src/strategy/backtest.ts (new module)
export interface BacktestReport {
  symbol: string;
  candleCount: number;
  closedTrades: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  profitFactor: number;
  maxDrawdownPercent: number;
}

/**
 * Replays `analyze()` + a fee-only paper fill against real historical
 * candles (already fetched via RestClient.getKline — see rest.ts:128 — never
 * fabricated), producing the same win-rate/profit-factor/drawdown metrics
 * `learning/analyzer.ts` already computes for live trades. Reuses
 * `calcWinRate`/`calcProfitFactor`/`calcMaxDrawdown` from `strategy/risk.ts`
 * rather than reimplementing them.
 */
export function runBacktest(
  candles: { openTime: number; open: number; high: number; low: number; close: number; volume: number }[],
  symbol: string,
  config: Config,
): BacktestReport;
```

This is a pure, offline replay — it never calls any exchange write endpoint and never touches the
live journal. It is the required gate (design principle 4) before any future change to
`indicators.ts`/`signals.ts`/`risk.ts` is trusted with real capital again: run it against at least
one real historical period for the symbols actually traded, and require non-negative `totalPnl`
net of `totalFees` before shipping.

**Acceptance criteria:**
- [ ] `runBacktest()` on a flat (zero-movement) synthetic candle series produces `closedTrades ===
  0` (F3's mechanism — a flat series has no real edge anywhere, so a correct strategy should not
  trade at all under §4/§5's gates, unlike today's behavior).
- [ ] `runBacktest()` on real historical Bybit candles (fetched once via `getKline`, cached to a
  fixture file for repeatable tests — never fetched live inside the test itself) for at least one
  symbol produces a report; the acceptance bar for actually *shipping* a strategy change is
  `totalPnl - totalFees >= 0` on that report, not merely that the function runs.

---

## Constraints

- **Bybit kline rate limits:** `getKline()` (`src/bybit/rest.ts:128-141`) goes through
  `withReadRetry`, the same rate-limit-aware wrapper every other REST read uses — no new
  rate-limit handling is needed, but the backtest harness must still **fetch once and cache to a
  local fixture file** (e.g. `tests/fixtures/<symbol>-klines-<range>.json`), never re-fetch on
  every test run — this is what §6's acceptance criteria already require, stated here as an
  explicit constraint rather than only an aside.
- **Runtime:** same as the rest of this repo — Node's `--experimental-strip-types`, ESM, no new
  runtime dependency required for §3-§6 (the new indicator/backtest code is pure TypeScript using
  only what `indicators.ts`/`risk.ts`/`rest.ts` already provide).
- **No new external dependency** is needed for any phase of this spec — §3's stateful indicators,
  §4's persistence gate, §5's cost check, and §6's backtest replay are all built from functions
  and API calls that already exist in this codebase.

---

## Phased rollout plan

### Phase 0 — this spec
Self-review via the spec-factory critique loop (rubric v2, threshold 20/24, no dimension at 0).

### Phase 1 (P0) — required before any further real-capital trading on this strategy
- [ ] §3 stateful/smoothed RSI + MACD (`updateRsi`, `updateMacd`, wired into `analyze()`)
- [ ] §4 signal-confirmation ticks for new entries + minimum hold before the "expert exit" rule
  (stop-loss/take-profit untouched, per design principle 3)
- [ ] Regression tests proving F1/F2's specific mechanisms are fixed (see Testing strategy)

### Phase 2 (P1) — required before trusting any further tuning of this strategy, or scaling capital
- [ ] §5 cost-aware entry gate (`hasPlausibleEdge`, wired into new-entry evaluation)
- [ ] §6 backtesting harness (`src/strategy/backtest.ts`), run at least once against real
  historical candles for the currently-configured/auto-selected symbols, showing non-negative
  expectancy net of fees

### Phase 3 (P2/P3) — hardening, not blocking
- [ ] §F6's MACD signal-line fix is actually §3's `updateMacd` — no separate work item; listed here
  only to confirm F6 is resolved once Phase 1 ships.
- [ ] F7: make the reason string reflect net directional consensus, not just list every
  individual factor regardless of which side it supports (e.g. prefix with "buy (3 bullish vs 1
  bearish factor)").
- [ ] F8: once §6's harness exists, run it against the current thresholds vs. at least one
  alternative set and record the comparison; re-tune only with backtest evidence, never by feel.

**No further real capital should be committed to this strategy, and no future indicator/threshold
change should be trusted, before Phase 1 and Phase 2 are both complete and at least one backtest
run (§6) shows non-negative expectancy net of realistic fees on real historical data.** The
current strategy, as measured live this session (§1.1-1.3), has a demonstrated near-100% fee-bleed
pattern across 21 closed trades — this is not a small-scale-acceptable risk, it is a guaranteed
loss mechanism that Phase 1 alone directly addresses.

---

## Testing strategy

- **Regression tests, not just new-behavior tests** (per F1/F2's exact mechanisms):
  - A test loading `tests/fixtures/apt-usdt-session-2026-09-07.json` and replaying the price
    sequence implied by trade ids 1-6's `entryPrice`s through the *old* `calcRSI` should reproduce
    the same instability (`100, 83.33, 62.5, 50, ...`); the *new* `updateRsi` against the same
    sequence should not swing by more than a bounded amount per tick once initialized.
  - A test replaying a synthetic entry/exit condition that persists for exactly 1 tick must show
    `analyze()` returning `hold` (post-fix) where it previously would have returned `buy`/`sell`.
- Exact gates: `tsc --noEmit` clean; `node --test --experimental-strip-types "tests/*.test.ts"` all
  green; the spec-factory critique verdict on this document itself is `accepted`.
- **Manual/live verification this can't fully replace:** after Phase 1 ships, a short (e.g. 2-4
  hour) live testnet observation confirming trade holding times are no longer sub-minute on
  average, and that stop-loss/take-profit still fire immediately (principle 3 must not have
  regressed) — automated tests cover the mechanism, not the live distribution of real holding
  times under real market noise.

---

## Out of scope
- Re-litigating `specs/live-trading-readiness.md`'s already-shipped execution-layer work
  (leverage pinning, circuit breakers, journal durability, reconciliation, the reentrancy guard
  fixed earlier in this session) — this spec is strategy-signal-quality only.
- A full alternative strategy (e.g. replacing indicator-consensus scoring with an ML model) — out
  of scope; this spec hardens the existing indicator-consensus approach, it doesn't replace it.
- Real (non-toy) fractional-Kelly sizing (`specs/live-trading-readiness.md` F17/§9) — separate,
  already-tracked work.
- Multi-symbol correlation-aware backtesting (the §6 harness runs one symbol at a time) — a
  natural Phase 4+ extension, not required to resolve F1-F8.

---

## Open questions
1. **`signalConfirmationTicks` and `minHoldBeforeExpertExitMs` defaults (2 ticks / 30s)** are a
   reasoned starting point (chosen to exceed this session's sub-minute round-trips), not
   backtest-validated — §6's harness, once built, should be used to check whether these specific
   defaults are actually good, or just "less bad than zero." Revisit once Phase 2 ships.
2. **Should the cost-aware gate (§5) use ATR, or the actual current order-book spread/depth** (the
   symbol-recommender already fetches real order-book depth per
   `specs/live-trading-readiness.md`'s later work) as its plausible-move proxy? ATR was chosen here
   because it's already computed per-tick in `signals.ts` with no new API calls; a spread-based
   version would be more accurate but costs an extra orderbook fetch per candidate per tick. Kept
   as ATR-based for Phase 2; revisit if backtest results show it's not a good enough proxy.
3. **A full ML-based or statistically-fit strategy replacement** was considered (given F8 shows
   every current threshold is an unvalidated guess) and explicitly deferred — it's a materially
   larger project than hardening the existing consensus-of-indicators approach, and §6's
   backtesting harness is a prerequisite for evaluating either path fairly. Revisit once Phase 2's
   harness exists and has a few real backtest runs to compare against.
