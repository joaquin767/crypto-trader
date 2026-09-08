# Profit Target & Capital Roadmap — Validation Spec

Status: **Revision 4 — Gate 0 has been built and run. Verdict: `no_edge`.**

> **Gate 0 result (2026-09-08):** 47 folds over 364 days, 1,792 closed trades.
> Median **−0.1767 %/day**, 15/47 folds positive, sign-test p = 0.9960, and **all five symbols lose
> money** over the full year. Artifact: `data/validation/walk-forward-2026-09-08.json`.
> Per §5 G0.6, this means **no real capital**: Gates 1 and 2 do not start and §8's go-live does not
> happen. See §5.7 for what the result actually says and §5.8 for the options.
>
> **The engine producing that verdict has since been independently corroborated** against freqtrade,
> trade-for-trade (§5.9). The cross-check found a real defect in our backtester first (artifact #9);
> after fixing it the two engines agree exactly, and the verdict is unchanged.

Revision 3 restructured the plan around a short-term go-live at bounded size (revision 2 assumed a
30-day testnet soak; §7.1 explains why that was dropped). Round 1 critique scored revision 1 at
19/24; those fixes are carried forward. The gate structure below is unchanged and remains the plan
if the strategy is ever revised — Gate 0 is now a harness that exists and can be re-run in ~15
minutes against any candidate.

Implemented for this spec: `scripts/backtest.ts`, `scripts/exit-mix.ts`, `scripts/walk-forward.ts`,
`src/strategy/training.ts`, `src/strategy/walkforward.ts`, `tests/walkforward.test.ts`.

Owner (every module this spec changes):
`src/strategy/backtest.ts`, `src/strategy/training.ts` (new), `src/strategy/walkforward.ts` (new),
`src/learning/journal.ts`, `scripts/train-model.ts`, `scripts/fetch-klines.ts`,
`scripts/walk-forward.ts` (new), `tests/walkforward.test.ts` (new), `config.json`.

Purpose: `specs/live-trading-readiness.md` made *execution* safe. `specs/strategy-signal-quality.md`
fixed *signal generation* and delivered a model with held-out AUC 0.6443. Neither answers the
question that gates real money: **does this system have a positive expectancy that survives out of
sample, and how large is it?** This spec answers that, gets the system live at bounded size quickly,
and ties every subsequent capital increase to a measurement rather than to hope.

---

## 0. How to read this document

- **§1** states the goal and rejects the goal it replaces.
- **§2** is the evidence. Every figure cites a committed artifact and the command that regenerates it.
- **§3** is the design principles every later section is checked against.
- **§4** is the audit, severity-tiered.
- **§5–§7** are the three gates that must pass **before real money**. Total cost: hours to days.
- **§8** is the go-live decision and the kill switch.
- **§9–§10** are what happens after go-live: capital scaling, and ongoing edge work.
- **§11–§15** close: constraints, out of scope, verification, assumptions, open questions.

Severity tiers (same scheme as the two prior specs):

- **P0 — blocks real capital.** Until closed, either the numbers are unfalsifiable or the downside
  is unbounded.
- **P1 — blocks scaling or diagnosing.** Real gaps that make tuning guesswork.
- **P2 — hardening.** Real quality gaps, not blocking.
- **P3 — improvement.**

---

## 1. Goal

**Get the system trading real capital at bounded size in the short term, and replace the target
"earn $200/day" with "scale capital in proportion to how well the edge is evidenced."**

Operating context, stated once so every later section can be checked against it:

- Current trading capital: **$100** (`config.json:9` → `"maxCapitalUsd": 100`).
- Funding available: **~$200/month** in deposits.
- Capital objective: **$3,000**.
- Venue: Bybit. **Testnet is a development environment, not a validation stage** — see §7.1.
- Intent: go live **within days**, not months.

### 1.1 — The goal this replaces, and why

"$200/day" is not a strategy parameter. Profit is `edge × capital`; tuning moves only `edge`, and
capital is set by deposits.

At the time this was written the best measured edge was +0.0836%/day, which put $200/day at
**$239,234** of capital — against an actual $100, i.e. **200% per day**. Gate 0 has since measured
the edge at **−0.1767%/day** (§5.7), at which no amount of capital produces $200/day in profit; it
produces losses proportional to size.

Either way the conclusion is the same and is the reason this spec exists: judging tuning decisions
against a $200/day bar would reliably produce over-fitting and over-leverage rather than profit.

### 1.2 — Why live trading cannot be the edge test, and what it *is* for

This is the load-bearing argument for the whole gate structure, so it is stated with its arithmetic.

At the observed trade rate (40 closed trades / 15 days / 5 symbols = **80 trades/month**), and
needing ~**2,500** trades to separate a 53% win rate from a coin flip at ~3σ:

| | Live @ $100 | Walk-forward over history |
|---|---|---|
| Trades per month | 80 | ~1,557 (in ~20 min of compute) |
| **Time to a verdict on edge** | **~31 months** | **~20 minutes** |
| One month of results | +$2.54 or −$0.54 (§2.4 bounds) | full fold distribution |
| Tests real fills / fees / slippage | **yes** | no |

**Live trading at $100 moves the balance by roughly two dollars a month. That is not a measurement.**
Edge can only be established from history, because only history has enough trades. Conversely, only
live trading tests whether real fills, fees and slippage match what the model assumed (A-3).

They are complementary and **neither is slow**. This is why Gate 0 (§5) is a hard pre-live gate
costing ~20 minutes, and why there is no multi-week soak anywhere in this document.

---

## 2. The evidence

### 2.1 — The measured result

Committed artifact `data/validation/baseline-backtest-2026-09-08.json`, regenerated by:

```bash
node --experimental-strip-types scripts/backtest.ts --data data/klines --config ./config.json --held-out 0.25
```

| Quantity | Value | Source |
|---|---|---|
| Held-out net P&L | **−$1.832 on $100** | artifact → `totals.totalPnl` |
| Window | 2026-08-24 → 2026-09-08, **15.0 days** | artifact → `window` |
| Closed trades | **55** | artifact → `totals.closedTrades` |
| Win rate | **49.1%** | artifact → `totals.winRate` |
| Daily return | **−0.1222%/day** | artifact → `totals.dailyReturnPercent` |
| Model held-out AUC | **0.6443** | `data/model/scalping-model.json` → `metrics.testAuc` |
| Model held-out samples | 3,127 | same → `metrics.testSamples` |
| Model base rate | 37.7% | same → `metrics.testBaseRate` |

**Three corrections on record for this one figure**, none of them a market observation:

| Reported | Cause |
|---|---|
| +$0.497 | uncommitted run, never reproducible |
| +$1.253 | first committed run |
| −$0.734 | fixing the executor timestamp bug (§2.5 #8) — the horizon exit had never fired in any backtest |
| **−$1.832** | fixing barrier fills (§2.5 #9), found by the freqtrade cross-check (§5.9) |

The sign of this project's headline number changed twice in one day, each time because of a defect.

**55 trades is far too few to distinguish from a coin flip** either way.
`scripts/backtest.ts` prints this warning below 200 trades. This number's real role is as an
illustration of why §5's Gate 0 exists, not as evidence of anything.

**AUC is not expectancy.** AUC 0.6443 is genuine ranking skill, above the 0.55 floor
`scripts/train-model.ts:251` warns below, yet it produces a marginal net return because ranking skill
is consumed by the 0.075% round-trip cost. No gate may be cleared on AUC alone.

### 2.2 — Per-symbol breakdown (F0)

From the same artifact's `perSymbol` array:

| Symbol | Trades | Net P&L |
|---|---|---|
*(per-symbol figures regenerate with the artifact; the shape below is what mattered)*

ARBUSDT supplied the large majority of trades from a single symbol, and three of five symbols produced
very few trades in 15 days — too few for their individual figures to mean anything. The headline was
never five independent confirmations; it was one symbol's fortnight plus noise.

**Gate 0 settled this directly.** Over the full 364 days, ARBUSDT — the symbol that carried every
favourable version of this number — **loses $12.48**, and so does every other symbol
(§5.7). The concentration was not a signal to be isolated; it was the shape of a result that had no
signal in it at all.

### 2.3 — Exit mix

Committed artifact `data/validation/exit-mix-2026-09-08.json`:

```bash
node --experimental-strip-types scripts/exit-mix.ts --data data/klines --held-out 0.25
```

Over **2,518** resolvable barrier paths at the deployed barriers (TP 1.5% / SL 1.5% / horizon 7
dollar bars): **42.2% take-profit, 40.3% stop-loss, 17.6% horizon timeout**; hold time median
**115 min** (p25 45, p75 250).

**Correction on record:** previously reported as "28% / 27% / 46%, median 150 min" from an
uncommitted run. Superseded.

**Reconciliation of 2,518 paths vs 40 trades:** different populations, not a contradiction.
`exit-mix.ts` treats *every* held-out bar as a hypothetical entry (unconditional); `backtest.ts`
counts only bars passing the model gate — top 5% of scores — whose post-only order also filled.
2,518 × 5% ≈ 126 candidates, further reduced by signal confirmation and end-of-window truncation to
40. **The unconditional mix is therefore not a valid prediction of the gated strategy's realised
mix**, which is why §9 compares live results against the walk-forward report's own predicted mix.

### 2.4 — Capital path to $3,000

Deposit $200 monthly, then compound that month's trading return. Start $100.

| Assumed edge | Months to $3,000 | Trading P&L |
|---|---|---|
| Pre-Gate-0 headline, +0.0836%/day | 13 | +$551 |
| **Zero — edge is noise** | **15** | $0 |
| **Gate 0 measured, −0.1767%/day (§5.7)** | **32** | **−$3,483** |

Deposits are the growth engine in every branch: even the most favourable estimate had the bot
contributing ~17% of the final balance. What the measured edge changes is the downside — at
−0.177%/day, reaching $3,000 takes **32 months instead of 15** and requires **$6,500 of deposits to
end up with $3,017**, because the strategy burns **$3,483** along the way. Running this
configuration would cost more than half of everything paid in.

The asymmetry that matters was never the money. It is that a negative edge left running also buys
false confidence, which is what carries into larger capital. §8.1's kill switch and §9's tier
schedule exist for that; Gate 0 is what makes them unnecessary here, by catching it first.

### 2.5 — Prior measurement failures, stated as a prior

Seven measurement artifacts have been found in this codebase, each of which had inflated reported
results until corrected:

1. `FEE_RATE = 0.001` hardcoded — ~2× the real round-trip cost.
2. Stop-loss measured from `currentPrice` instead of `entryPrice` — the stop went dead on any
   reconciled position.
3. ATR computed over a 24h range instead of 5m candles — read 8.76% where the truth was 0.58%.
4. Maker fees applied to both legs, when exits are always taker by design.
5. Model scores window-dependent — the same bar scored 0.598 with 300 candles of context and 0.441
   with 1000 (`src/strategy/model.ts:131-144` states both figures verbatim).
6. §2.1's headline P&L — not reproducible, off by 2.5×.
7. §2.3's exit mix — not reproducible.
8. **`src/executor.ts` stamped every fill with `Date.now()` instead of the snapshot's own
   timestamp.** Live those coincide, so nothing looked wrong. In a backtest replaying historical
   candles they are up to a year apart: `position.openedAt` was set to *today* while
   `snapshot.timestamp` stayed in the past, making `ageMs = snapshot.timestamp - position.openedAt`
   **negative**, so `signals.ts`'s horizon exit could never fire. **No backtest this project has
   ever run modelled the horizon exit at all**, while live did — a train/serve divergence in the
   *exit* path, invisible because it produced plausible numbers. Fixing it moved §2.1 from +$1.253
   to −$0.734 and raised the walk-forward's horizon-exit share from 0.0% to 27.1%.

9. **`runBacktest` filled barrier exits at the bar's CLOSE rather than at the barrier price.** A
   stop-loss or take-profit resting at the exchange triggers the moment price *touches* the level
   and fills at approximately that level; it does not wait for the bar to close. The replay only
   evaluated exits at each bar's close and then filled there. Found by the freqtrade cross-check
   (§5.9), which disagreed on **40 of 60 trades**: one APT stop at 0.9295 filled at that bar's close
   of 0.9052 for **−4.08%** instead of ~−1.49%, and symmetrically winners ran past take-profit to
   **+5.19%** against a +1.5% barrier. Losers overshot by 16.7pp in total and winners by 16.2pp
   across one 90-day window — enough to flip that window's sign. Fixed with intra-bar barrier
   detection, pessimistic on ambiguity (a bar spanning both barriers takes the stop).

Eight of these nine moved results **downward** when corrected; #9 was the first that did not move
them consistently in one direction. The prior this establishes: an unvalidated favourable result
from this codebase should be assumed inflated until a fold-level test says otherwise — and §5.7 is
what happened when one finally was.

---

## 3. Design principles

**P-1 — Fail closed on unproven edge.** Where evidence is ambiguous, the system trades at the
*current* capital tier or smaller — never larger. Capital increases require a positive measurement;
they never happen by default, by elapsed time, or because a gate was "probably" met.

**P-2 — A gate is cleared by a recorded number, not a judgment.** Each gate names the committed
artifact that clears it and the command that regenerates it. §2.1 and §2.3 show what violating this
looks like.

**P-3 — Measure out of sample, always.** Any statistic justifying a capital increase must come from
data the model was not fit on.

**P-4 — Report the null result as loudly as the positive one.** A gate that fails is a successful
measurement. Never degrade to a weaker test to manufacture a pass.

**P-5 — Bounded, observable downside beats delayed deployment.** Real capital at a size where being
wrong costs tens of dollars teaches more than any length of simulated trading, *provided* the loss
limit is automatic rather than discretionary. This principle is what permits §8's short-term
go-live; §8's kill switch is what makes it safe.

---

## 4. Audit

### 4.1 — P0 findings (block real capital)

#### F0. The entire measured result is attributable to one symbol
Per §2.2: ARBUSDT is 26 of 40 trades and +$1.522 of a +$1.253 total; the other four symbols together
lose $0.269 over 14 trades. Three symbols produced ≤ 5 trades in 15 days.
**Consequence:** every downstream number inherits single-symbol, single-regime risk. Gate 0 must
report per-symbol breakdowns and must not clear on a pooled figure one symbol dominates.

#### F1. No walk-forward validation exists anywhere in the codebase
`grep -rin "walk.forward\|walkForward" --include=*.ts .` returns one hit — a comment at
`scripts/train-model.ts:4` describing triple-barrier *labelling*, not validation.
`scripts/train-model.ts:197-202` performs a **single** chronological split (`testFraction` 0.25),
reporting one AUC from one window in one regime.
**Consequence:** §2.1's headline has no error bars and no regime coverage, and it is the number every
capital decision would rest on.

#### F2. Exit reason is not recorded, so live losses cannot be attributed
`TradeRecord` (`src/learning/journal.ts:18-39`) has `reason: string` populated at *entry* (`:31`)
plus `exitPrice`/`exitTime`/`pnl`, but **no exit-reason field**; `grep -rn "exitReason"` returns zero
hits repo-wide.
**Consequence:** once live with real money, a losing streak cannot be diagnosed as "stops too tight"
versus "horizon too short" versus "the model gate stopped working." This is P0 *because* the plan is
to go live quickly: it is the instrumentation that makes the live phase informative rather than just
expensive.

#### F3. Concurrency and correlation limits are implemented but not enabled
`checkConcurrentPositionsLimit()` (`src/strategy/concentration.ts:16`, early `return { skip: false }`
at `:20`) and `checkCorrelationLimit()` (`:72`, early return at `:78`) both no-op when their config
value is `undefined`. `src/config.ts:195-196` reads both as optional and **neither key is present in
`config.json`**.
**Consequence:** unlimited simultaneous positions and no correlation guard, so nominal per-position
risk understates true portfolio risk. Tolerable while paper trading; not tolerable with real money.
Promoted to P0 by the decision to go live.

### 4.2 — P1 findings

#### F4. Only 60 days of history exists, bounding Gate 0's statistical power
Every file in `data/klines/` holds **17,280 bars spanning 2026-07-10T01:35Z → 2026-09-08T01:30Z =
60.0 days**. At 30-day train / 7-day test / 7-day step that yields **4 folds** — under-powered by
roughly an order of magnitude. Fixed by G0.1, which costs ~2 minutes.

### 4.3 — P2 findings

#### F5. The test suite writes session logs into `logs/`
Test runs deposit session logs beside real trading logs, creating fabricated histories next to
genuine ones. The same class of bug — tests overwriting the live `trade-journal.json` — was proven
with a sentinel record and fixed in commit `f70700a` by chdir-ing to a temp directory; the logging
path never received the same fix.

#### F6. One-bar decision delay after every restart
The kline backfill includes the in-progress bar, so the first decision after a restart evaluates a
partial candle. Low impact at a 25-minute mean bar duration
(`data/model/scalping-model.json` → `trainedOn.avgBarMs: 1500000`), but a real train/serve difference.

---

## 5. Gate 0 — Is there an edge? (P0, ~25 minutes)

**The one gate that can invalidate the project. It costs ~20 minutes of compute and it runs before
any real money.**

### G0.1 — Extend the dataset (~2 minutes)

Fetch **365 days** of 5m klines for the 5 trained symbols plus 3 never used in training or tuning
(the held-out universe §10 re-validates against). Written to a **new directory** so the existing
60-day files stay intact and §2's artifacts remain reproducible:

```bash
node --experimental-strip-types scripts/fetch-klines.ts --days 365 --interval 5 --out data/klines-365 \
  --symbols APTUSDT,ARBUSDT,LINKUSDT,OPUSDT,SOLUSDT,AVAXUSDT,DOTUSDT,INJUSDT
```

- [ ] Given `--days 365`, when the fetch completes, then each `data/klines-365/<SYM>-5m.json`
      contains ≥ 100,000 candles and `lastOpenTime - firstOpenTime` ≥ 350 days.
- [ ] Given any symbol for which Bybit returns a span < 350 days, when the fetch completes, then the
      script prints the actual per-symbol span and **exits non-zero**, writing no partial file for
      that symbol (P-1). *(Current behaviour warns and skips — `scripts/fetch-klines.ts:93-96` — so
      this requires a change.)* Resolving Q-1 by substituting a shorter span is a deliberate,
      separately recorded decision, never the script's default.

### G0.2 — Prerequisite refactor: make the training path importable

`scripts/train-model.ts` **exports nothing** — `buildSamples`, `standardise`, `train`, `evaluate` are
module-private and the file ends in a top-level `await main()`, so importing it runs a full training
job as a side effect. Extract into `src/strategy/training.ts`, leaving the script a thin CLI:

```ts
export interface Sample { x: number[]; y: number; t: number; symbol: string }

export interface TrainParams {
  tp: number; sl: number; horizon: number;
  epochs: number; lr: number; l2: number;
  /** Time bars per dollar bar; 0 keeps plain time bars. Same units and meaning
   *  as scalping-model.json trainedOn.timeBarsPerDollarBar. */
  dollarBars: number;
}

export interface FitResult { weights: number[]; bias: number; mean: number[]; std: number[] }
export interface EvalResult { accuracy: number; auc: number; baseRate: number; n: number }

/** Build labelled samples from candles already restricted to the intended
 *  window. Pure: no I/O, no clock. */
export function buildSamples(bySymbol: Record<string, Candle[]>, p: TrainParams): Sample[];

/** Standardisation constants from the TRAINING set only. */
export function standardise(train: Sample[]): { mean: number[]; std: number[] };

/** Deterministic: same samples + params ⇒ bit-identical weights. No RNG,
 *  no shuffling, no wall-clock. */
export function fit(train: Sample[], p: TrainParams): FitResult;

export function evaluate(samples: Sample[], f: FitResult): EvalResult;
```

- [ ] Given `await import("../src/strategy/training.ts")`, when it resolves, then no file has been
      read or written and no model trained (no import-time side effects).
- [ ] Given identical inputs, when `scripts/train-model.ts` runs before and after the refactor, then
      it writes a **byte-identical** `scalping-model.json`.
- [ ] Given the same `Sample[]` and `TrainParams`, when `fit` is called twice, then both `FitResult`s
      are deep-equal.

### G0.3 — Required changes to `runBacktest`

`src/strategy/backtest.ts:63` currently takes no model argument (it calls
`loadModel(DEFAULT_MODEL_PATH)` internally) and `BacktestReport` exposes only aggregates. The harness
needs a fold-specific model and a per-trade series:

```ts
export async function runBacktest(
  candles: Candle[],
  symbol: string,
  config: Config,
  /** Score against THIS model. Omitted ⇒ current behaviour: loadModel(DEFAULT_MODEL_PATH).
   *  The harness always passes it explicitly — a fold must never be scored by a
   *  model fit on data outside its own training window. */
  model?: ModelWeights,
): Promise<BacktestReport>;

export interface BacktestReport {
  // ...all existing fields unchanged...
  /** Portfolio value after each bar. Already computed internally; this exposes it. */
  equityCurve: number[];
  /** One entry per CLOSED trade, in exit order. */
  trades: { entryTime: number; exitTime: number; pnl: number; exitReason: ExitReason }[];
}
```

- [ ] Given `runBacktest` called without `model`, when it runs, then its report matches pre-change
      behaviour (existing callers and tests unaffected).
- [ ] Given two different `ModelWeights` over identical candles, when both run, then the reports
      differ — proving the parameter is honoured and not shadowed by `loadModel`.

### G0.4 — The walk-forward harness

New module `src/strategy/walkforward.ts`. Retrains from scratch on each fold's training window and
evaluates only on the untouched window after it.

```ts
import type { Candle, BacktestReport } from "./backtest.ts";
import type { Config } from "../config.ts";

/** Day→ms conversion used throughout. All Fold bounds are ms epoch; all
 *  *Days params are whole days. */
export const DAY_MS = 86_400_000;

export class WalkForwardError extends Error {
  constructor(message: string, readonly foldIndex: number | null) { super(message); }
}

export interface Fold {
  index: number;
  /** ms epoch, half-open [start, end). */
  trainStart: number; trainEnd: number;
  testStart: number;  testEnd: number;
}

export interface FoldResult {
  fold: Fold;
  trainSamples: number;
  testSamples: number;
  testAuc: number;          // out-of-sample ranking skill; 0.5 = none
  testBaseRate: number;
  /** One report per symbol — runBacktest is per-symbol and never aggregates. */
  perSymbol: Record<string, BacktestReport>;
  closedTrades: number;                    // Σ perSymbol[].closedTrades
  /** Σ perSymbol[].totalPnl / config.maxCapitalUsd × 100. Symbols share one
   *  capital denominator, matching how the live bot is funded (A-7). */
  netReturnPercent: number;
  /** netReturnPercent / ((fold.testEnd - fold.testStart) / DAY_MS) */
  dailyReturnPercent: number;
  pnlBySymbol: Record<string, number>;     // for the F0 concentration check
  /** Realised mix over this fold's closed trades, from trades[].exitReason.
   *  Shares sum to 1. */
  exitMix: { takeProfit: number; stopLoss: number; horizon: number };
}

export interface CandidateRecord {
  label: string;
  medianDailyReturnPercent: number;
  maxDrawdownPercent: number;
  adopted: boolean;
}

export interface WalkForwardReport {
  generatedAt: string;                 // ISO 8601 — the ONLY non-deterministic field
  command: string;                     // exact regeneration command (P-2)
  symbols: string[];
  trainDays: number; testDays: number; stepDays: number;
  folds: FoldResult[];
  totalFolds: number;
  positiveFolds: number;               // folds with netReturnPercent > 0
  medianDailyReturnPercent: number;
  meanDailyReturnPercent: number;
  medianAuc: number;
  totalClosedTrades: number;
  /** Max peak-to-trough decline of the equity curve formed by merging every
   *  fold's trades[], time-sorted by exitTime across folds and symbols, as a
   *  running sum of pnl over config.maxCapitalUsd. */
  maxDrawdownPercent: number;
  /** 90th percentile of per-fold maxDrawdownPercent — sets §9's demotion
   *  threshold, resolving Q-4. */
  foldDrawdownP90: number;
  pnlBySymbol: Record<string, number>;
  /** Largest single symbol's share of total POSITIVE P&L, in [0,1]. */
  topSymbolProfitShare: number;
  /** Aggregate realised exit mix — the baseline §9 compares live against. */
  exitMix: { takeProfit: number; stopLoss: number; horizon: number };
  /** Aggregate post-only fill rate — the other §9 comparison baseline. */
  restingFillRate: number | null;
  /** One-sided binomial, P(X >= positiveFolds | n=totalFolds, p=0.5). */
  signTestPValue: number;
  candidatesEvaluated: number;         // 1 for a plain Gate 0 run
  candidates: CandidateRecord[];       // [] for a plain Gate 0 run
  verdict: "edge_confirmed" | "no_edge" | "insufficient_data";
  /** Names which G0.6 step decided it, e.g. "step 3: positiveFolds 22/45 = 0.489 < 0.55". */
  verdictReason: string;
}

/** Chronological folds over [firstMs, lastMs). Returns [] if fewer than one
 *  full train+test window fits — never a partial or shortened fold. */
export function buildFolds(
  firstMs: number, lastMs: number,
  trainDays: number, testDays: number, stepDays: number,
): Fold[];

/**
 * Runs the full walk-forward.
 *
 * Rejects with WalkForwardError (never resolves with a partial report) when:
 *  - any symbol file is absent, unparseable, or does not cover [firstMs, lastMs)
 *  - any fold's training window yields < 1000 samples
 *  - any fold fails to train or backtest
 */
export function runWalkForward(opts: {
  dataDir: string;
  symbols: string[];
  config: Config;
  trainDays: number;   // default 30
  testDays: number;    // default 7
  stepDays: number;    // default 7
  tp: number; sl: number; horizon: number; dollarBars: number;
}): Promise<WalkForwardReport>;
```

CLI wrapper `scripts/walk-forward.ts` writes `data/validation/walk-forward-<ISO date>.json` and
**commits it** — the report is the gate artifact (P-2). `data/validation/` is not gitignored
(`.gitignore:29` covers only `data/klines/`).

### G0.5 — Acceptance criteria

- [ ] Given a 365-day dataset with `trainDays=30, testDays=7, stepDays=7`, when `buildFolds` runs,
      then it returns **≥ 45 folds**, each satisfying `fold.testStart === fold.trainEnd` and
      `folds[i].testStart === folds[i-1].testStart + stepDays * DAY_MS`.
- [ ] **No look-ahead.** Given a fold, when every candle with `openTime >= fold.testStart` is
      replaced by `NaN` and *only the training half* is re-run, then the resulting `FitResult`
      (`weights`, `bias`, `mean`, `std`) and that fold's per-symbol dollar-bar thresholds are
      deep-equal to those from unpoisoned data. Asserted by
      `tests/walkforward.test.ts::no-lookahead`, which calls the fold-training function twice and
      deep-equals the two artifacts. *(The test window is evaluated separately on unpoisoned data —
      poisoning it and asserting on `testAuc` would make the assertion NaN by construction.)*
- [ ] Given a range shorter than `trainDays + testDays`, when `buildFolds` runs, then it returns `[]`
      and `runWalkForward` resolves with `verdict: "insufficient_data"` — never a partial fold, never
      a silently shortened training window (P-1).
- [ ] Given any symbol file absent, unparseable, or not spanning the full fold range, when
      `runWalkForward` starts, then it rejects with `WalkForwardError` naming that symbol **before
      evaluating any fold** — never silently dropping a symbol (P-1).
- [ ] Given a fold whose training window yields < 1,000 samples, when it is evaluated, then
      `runWalkForward` rejects with
      `new WalkForwardError("fold 12 train window has 840 samples (< 1000)", 12)`.
- [ ] Given a report, when `totalFolds < 20` or `totalClosedTrades < 200`, then
      `verdict === "insufficient_data"` regardless of how favourable the returns look (P-4).
- [ ] Given the harness runs twice on identical inputs, when the reports are compared, then every
      field except `generatedAt` is deep-equal (no unseeded randomness, no wall-clock in training).
- [ ] Given a fold with zero closed trades, when it is scored, then `netReturnPercent === 0`, it
      counts toward `totalFolds`, and it does **not** count toward `positiveFolds`.

### G0.6 — Kill criterion

Compute in this exact order; the first matching step decides the verdict and is recorded in
`verdictReason`:

1. `totalFolds < 20 || totalClosedTrades < 200` → **`insufficient_data`**. Not a pass, not a fail.
   Extend the dataset and re-run.
2. `medianDailyReturnPercent <= 0` → **`no_edge`**. *(Even-length median is the mean of the two
   central values, compared to 0.)*
3. `positiveFolds / totalFolds < 0.55` → **`no_edge`**.
4. `signTestPValue > 0.10` → **`no_edge`**. Computed as the one-sided upper tail **inclusive of the
   observed count**: `P(X >= positiveFolds)` for `X ~ Binomial(totalFolds, 0.5)`.
5. `topSymbolProfitShare > 0.60` → **`no_edge`**, reason `"single-symbol concentration"` (F0). A
   result carried by one symbol is a symbol observation, not a strategy edge.
6. Otherwise → **`edge_confirmed`**; `medianDailyReturnPercent` becomes the project's official edge
   estimate, superseding §2.1 everywhere.

**On `no_edge`: no real capital.** Gates 1 and 2 do not start, §8's go-live does not happen. The
response is one of — (a) return to feature/label research with the harness now in place to judge it,
(b) continue paper trading indefinitely, (c) stop. Which is the user's call; this spec does not
pre-empt it. What is **not** permitted is going live with a `no_edge` verdict on record, or re-running
with adjusted parameters until a pass appears (A-4).

**Honest statement of power:** at 45 folds a sign test detects an edge winning ~65% of folds at
p < 0.10. It will **not** reliably detect a true edge of 0.03%/day, whose fold-level sign is nearly a
coin flip against 5m noise. `no_edge` therefore means *"no edge large enough to matter at this
capital scale has been demonstrated"* — not *"an edge is proven absent."* Both readings lead to the
same action, because an edge too small for this test to see is too small to justify funding.

---

## 5.7 — Gate 0 result (run 2026-09-08)

Artifact: `data/validation/walk-forward-2026-09-08.json`. Regenerate with §13's command (~15 min).

| Metric | Value | G0.6 bar |
|---|---|---|
| Folds | **47** | ≥ 20 ✅ |
| Closed trades | **1,792** | ≥ 200 ✅ |
| **Median daily return** | **−0.1767 %/day** | > 0 ❌ **step 2** |
| Mean daily return | −0.2650 %/day | — |
| Positive folds | **15 / 47 (31.9%)** | ≥ 55% ❌ |
| Sign-test p | **0.9960** | ≤ 0.10 ❌ |
| Median fold AUC | 0.5464 | — |
| Max drawdown | 90.89% | — |
| Exit mix | TP 35.8% / SL 44.9% / horizon 19.3% | — |

*(Re-run after fixing artifact #9. The pre-fix run gave −0.1840 %/day over 1,603 trades — the
verdict is unchanged by the correction, which is itself evidence that it is not an artifact.)*

**Verdict: `no_edge`** — decided at step 2 (median ≤ 0), and it would independently have failed
steps 3 and 4.

**P&L by symbol over the full year — every symbol loses:**
APTUSDT −$18.02 · ARBUSDT −$12.48 · LINKUSDT −$13.83 · OPUSDT −$27.35 · SOLUSDT −$15.49.

### 5.7.1 — Why every earlier measurement disagreed

Fold returns split cleanly by period:

| Period | Folds | Median fold return | Positive |
|---|---|---|---|
| 2025-10-08 → 2026-06-24 | 39 | **−1.683%** | 10 / 39 (26%) |
| 2026-07-01 → 2026-08-26 | 8 | **+0.240%** | 4 / 8 (50%) |

**The last two months were the only non-losing stretch in the year, and every prior measurement was
taken from inside it.** The 60-day dataset in `data/klines/` begins 2026-07-10 — it contains almost
nothing but that favourable window. This is not a subtle statistical point; it is the entire
explanation for the gap between "+0.08%/day" and "−0.18%/day", and it is precisely the selection
effect walk-forward exists to expose.

### 5.7.2 — What the result does and does not say

**Does say:** the deployed configuration — 21 features, logistic regression, dollar bars, TP 1.5% /
SL 1.5% / horizon 7 bars, top-5% percentile gate, post-only entries — has negative expectancy net
of fees across 364 days and 1,603 trades, on all five symbols. That is a large enough sample and a
consistent enough sign that it is not a near-miss.

**Does not say:** that no edge exists in crypto scalping, or that this codebase cannot find one.
Median fold AUC 0.5464 means the model retains *some* out-of-sample ranking skill — it is above
0.50 in most folds. The skill is simply far too small to survive the 0.075% round-trip cost at a
1.5%/1.5% barrier whose unconditional base rate is only ~41% favourable. **The cost structure, not
the absence of any signal, is what makes this configuration lose.**

## 5.8 — Options from here (the user's decision, not this spec's)

Recorded so the choice is explicit rather than drifted into. All of these keep real capital at zero.

- **(a) Re-specify the strategy and re-run Gate 0.** The harness now exists and takes ~15 minutes,
  so candidate configurations are cheap to test. §5.7.2 points at the highest-value axes: the
  barrier geometry (a 41% base rate against a 52.5% break-even is a structural deficit no gate can
  fix) and the cost structure (maker-only exits would cut the round trip from 0.075% to 0.04%,
  changing the break-even win rate from 52.5% to 51.3%).
- **(b) Keep it running on testnet as a development target** and treat the bot as an engineering
  project rather than an income source.
- **(c) Stop.** The measured answer is that this configuration loses money; not building further on
  it is a legitimate response to that.

What is **not** on the list is funding the account and finding out live. §1.2's arithmetic already
established that live trading at $100 cannot measure edge — but it can certainly realise a −0.18%/day
one, and at that rate the §8.1 kill switch would trip inside four months.

## 5.9 — Independent corroboration: the freqtrade cross-check

Gate 0's verdict comes from a codebase that produced eight measurement artifacts in a day. Before
accepting a result that decides whether real money is ever committed, the machinery itself was
checked against [freqtrade](https://github.com/freqtrade/freqtrade) (54.2k stars, 32k commits).
Setup, rationale and runbook: `crosscheck/README.md`.

**Method.** Not a reimplementation — our entry rule is a rule-based score *and* a cost gate *and* a
21-feature model *and* a confirmation streak, so rebuilding it in pandas would add more divergence
risk than it removes. Instead our engine **exports its entry decisions** and a freqtrade strategy
replays them, applying freqtrade's own fills, barriers, horizon exit, fees and P&L. That isolates
the execution/accounting layer, which is where every one of the nine artifacts lived.

**It found a real bug in our engine before it agreed with it** (artifact #9, §2.5): barrier exits
filled at the bar's *close* rather than at the barrier price, wrong on 40 of 60 trades.

**Result after the fix** — window 2025-12-09 → 2026-03-09, 5 symbols:

| | Our engine | freqtrade |
|---|---|---|
| Trades | 68 | 68 |
| Entry bars matched | — | **68 / 68** |
| Exit reasons matched | — | **68 / 68** (34 SL, 29 TP, 5 horizon) |
| Gross-return mismatches > 0.05pp | — | **0** |
| Net P&L | −$4.274 | −$4.210 |

The residual $0.06 is position sizing (ours risk-based per symbol, freqtrade a flat $25 stake),
which is deliberately excluded from the comparison.

Two alignment defects on the *freqtrade* side were also found and fixed, both of which had silently
produced wrong output rather than an error: `custom_exit` is only called when `use_exit_signal` is
True (so the 4h horizon never fired, and a 14h20m trade ran under a 4h horizon), and `minimal_roi`
is measured on profit *net* of fees, so `0.015` demanded a 1.611% gross move rather than 1.5%.

**What this does and does not license.** The execution and accounting layer is now independently
validated, so Gate 0's `no_edge` rests on machinery two engines agree about. It does **not** validate
signal generation or feature computation, which are shared rather than reimplemented — those are
covered by `tests/walkforward.test.ts::no-lookahead`. Stating that boundary is the point.

---

## 6. Gate 1 — Attribution & portfolio safety (P0, hours)

Blocked by Gate 0 returning `edge_confirmed`. These are the instruments that make the live phase
informative and its downside bounded.

### G1.1 — Exit attribution (F2)

```ts
// src/learning/journal.ts
export type ExitReason =
  | "take_profit" | "stop_loss" | "horizon"
  | "manual" | "circuit_breaker" | "reconciled";

/** Aggregate bucket for pre-Gate-1 records carrying no exitReason.
 *  Deliberately NOT a member of ExitReason: no new trade may be written as "unknown". */
export type ExitReasonBucket = ExitReason | "unknown";

export interface TradeRecord {
  // ...existing fields unchanged...
  exitReason?: ExitReason;   // set exactly when status transitions to "closed"
}
```

- [ ] Given a position closed by `checkImmediateExit()` on a take-profit trigger, when the record is
      written, then `exitReason === "take_profit"`.
- [ ] Given each of stop-loss, horizon expiry, manual close and circuit-breaker close, when the
      position closes, then `exitReason` is the corresponding value.
- [ ] Given a close path supplying no reason, when the record is written, then
      `exitReason === "reconciled"` and a `WARN` naming the symbol is logged — never left `undefined`
      silently (P-1).
- [ ] Given a journal written before this change, when it loads, then records without `exitReason`
      load successfully and aggregate as `"unknown"` — no migration, no crash, no fabricated values.

### G1.2 — Enable the portfolio guards (F3)

- [ ] Given `config.json`, when the bot starts, then `maxConcurrentPositions: 2` and
      `maxCorrelation: 0.7` are set and logged at startup.
- [ ] Given real capital (`--live`), when either key is unset, then **startup refuses to run** with a
      named error (P-1) — the guard cannot be silently absent with money at risk.

### G1.3 — Verify the circuit breakers actually fire

The breakers exist (`src/risk/circuit-breaker.ts`, `specs/live-trading-readiness.md` §5) but have
never been observed halting a live session.

- [ ] Given a simulated day breaching `maxDailyLossPercent`, when the next entry is evaluated, then
      it is refused and the halt reason names the daily-loss breaker.
- [ ] Given each of `maxDrawdownHaltPercent`, `maxConsecutiveLosses` and `maxSlippagePercent`, when
      breached in a test, then entries halt and the reason names that specific breaker.
- [ ] Given any breaker halts entries, when an open position hits its stop-loss, then the **exit
      still executes** — breakers halt entries only, never closes.

Also closes **F5** (P2): tests chdir to a temp directory before logger initialisation, matching
`f70700a`.

**Gate 1 clears when:** `npm run verify` is green and a paper session of ≥ 20 closed trades shows
`exitReason` populated on 100% of closed records.

---

## 7. Gate 2 — Mainnet mechanics smoke test (P0, ~1 hour)

Blocked by Gate 1. The first real money, at minimum size, testing mechanics only — not edge (§1.2).

### 7.1 — Why this replaces the 30-day testnet soak

An earlier revision required 30 days on testnet before real capital. That is dropped, for a reason
stronger than time: **testnet has no real fills.** Its order book is thin and synthetic, so a month
there tests almost nothing that a backtest doesn't already model, while the one assumption that
actually needs testing (A-3: testnet fills ≈ mainnet fills) is *precisely* what testnet cannot
verify. It was simultaneously the slowest and the weakest gate in the document. Testnet remains the
development environment; validation moves to a short, small, real-money test.

### 7.2 — Criteria

Run with `maxCapitalUsd: 100` and `maxPositionSizeUsd` at the exchange minimum, until **10 closed
round trips** have accumulated.

- [ ] Given 10 closed round trips, when fees are summed from the exchange's own fill data, then the
      realised round-trip cost is within **0.02 percentage points** of the modelled 0.075% (§11.3).
- [ ] Given the same trades, when realised maker fill rate is computed, then it is within **20
      points** of the Gate 0 report's `restingFillRate`.
- [ ] Given the same trades, when each fill price is compared to the market price at signal time,
      then no fill slips more than `maxSlippagePercent` — and any that does has tripped the breaker.
- [ ] Given the run, when the journal is inspected, then all 10 records carry a populated
      `exitReason` (G1.1) and reconcile against the exchange's position history with no orphans.
- [ ] Given any criterion fails, when the gate is evaluated, then **the model is wrong, not the
      market** — stop, fix, and re-run the smoke test. Do not proceed to §8 (P-1).

**Expected cost of this gate:** at $100 and 10 trades, the total fee spend is roughly $0.08 and the
plausible P&L swing is under $2. This is the cheapest possible test of the most important unverified
assumption in the project.

---

## 8. Go-live decision and the kill switch

**Explicit go/no-go (L-007):** *Real capital beyond the §7 smoke test may be traded only when Gate 0
returned `edge_confirmed` with its report committed, Gate 1's criteria all pass, and Gate 2's smoke
test passes all five criteria.* There is no time-based requirement anywhere in that sentence — the
gates are cheap, and the whole sequence is days.

### 8.1 — The kill switch (P0)

P-5 permits a short-term go-live *because* the downside is automatic and bounded. It is not bounded
by intention; it is bounded by these:

- [ ] Given cumulative realised P&L since go-live reaches **−20% of `maxCapitalUsd`**, when the next
      cycle runs, then the bot **halts all new entries permanently** (not until tomorrow), logs the
      reason, surfaces it on the dashboard, and requires an explicit config change to resume.
- [ ] Given the halt fires, when an open position exists, then its stop-loss and take-profit continue
      to execute — the kill switch stops entries, never exits.
- [ ] Given the bot has been live for 30 days, when realised P&L is negative, then it drops to
      paper mode automatically and a walk-forward re-run is required before resuming (P-1).
- [ ] Given the kill switch or the 30-day rule fires, when the user resumes, then the resume is
      recorded in the journal with a timestamp, so a pattern of repeated overrides is visible rather
      than invisible.

**At $100 the kill switch caps the loss at $20.** That is the number that makes going live now a
reasonable risk rather than a hopeful one.

---

## 9. Capital scaling after go-live (P1)

Deposits accumulate regardless of gate status; this schedule governs only how much of the balance is
*exposed to the strategy*.

**Drawdown definition used throughout:** the maximum peak-to-trough decline of the **deposit-adjusted
strategy equity curve** — the running sum of realised P&L net of fees over closed `TradeRecord`s,
deposits excluded — over any trailing 30-day window, as a percent of `maxCapitalUsd`. Deposits are
excluded because $200/month flowing into the same balance would otherwise mask real losses.

| Tier | `maxCapitalUsd` | Requires | Demotion trigger |
|---|---|---|---|
| T0 | 100 | §8 go-live criteria | kill switch (−20%) |
| T1 | 250 | 30 days at T0, realised return ≥ 0, and realised daily return inside the 10th–90th percentile of Gate 0's fold distribution | drawdown > `foldDrawdownP90` |
| T2 | 500 | 30 days at T1 within band | drawdown > `foldDrawdownP90` |
| T3 | 1,000 | 30 days at T2 within band, **and** a committed capacity curve (§9.1) | drawdown > `foldDrawdownP90` |
| T4 | 3,000 | 30 days at T3 within band, **and** the capacity curve shows $3,000 retains ≥ 50% of edge | drawdown > `foldDrawdownP90` |

- [ ] Given a tier promotion, when applied, then the walk-forward report path justifying it is
      recorded in the commit message.
- [ ] Given a demotion trigger fires, when detected, then `maxCapitalUsd` drops **one full tier
      immediately** and re-promotion requires a fresh 30-day window. Demotion is automatic; promotion
      is manual (P-1: the asymmetry is intentional).
- [ ] Given the live exit mix drifts more than **10 percentage points per bucket** from the Gate 0
      report's `exitMix`, when detected, then promotion is blocked until it is explained — live and
      backtest are no longer sampling the same process.

The demotion threshold is `foldDrawdownP90` from the Gate 0 report (§G0.4), **not** a hand-picked
number: a demotion should signal genuinely abnormal behaviour, not an ordinary bad week. This
resolves Q-4.

### 9.1 — Capacity (required only above T2)

Edge does not scale linearly: exits are taker and slip, and post-only fill rates fall as resting size
grows relative to book depth. Required before T3, not before go-live.

**Cost-model exception (§11.3):** enabling the slippage term invalidates prior gate artifacts —
Gate 0 must be re-run with it enabled before T3 clears.

- [ ] Given the live configuration, when the harness runs at `maxCapitalUsd` ∈ {100, 500, 1000,
      3000}, then a capacity curve of `medianDailyReturnPercent` vs capital is committed to
      `data/validation/capacity-<ISO date>.json`.
- [ ] Given a modelled exit whose notional exceeds 0.5% of top-5-level depth, when it is priced, then
      the backtest charges exactly
      `slippagePercent = 0.5 * (notionalUsd / top5DepthUsd) * spreadPercent`, capped at **0.20%**, in
      addition to the taker fee.
- [ ] Given historical klines carry no book depth, when the harness needs `top5DepthUsd`, then it
      uses a per-symbol constant sampled from **live order books over ≥ 1,000 observations** and
      committed to `data/validation/depth-<ISO date>.json` — never a hard-coded guess, never inferred
      from OHLC.

### 9.2 — Leverage

Leverage multiplies edge and variance together. Applied to an edge whose confidence interval straddles
zero (§2.1, §2.2), it is purely a variance multiplier — it raises the probability of ruin without
raising expectancy. **Leverage above 1× is out of scope for this entire roadmap**, reconsiderable only
in a future spec after T4 has been held 90 days with realised results inside the predicted band
(A-5).

---

## 10. Ongoing edge improvement (P1, never blocks live)

Runs offline, in parallel with live trading. Every candidate change — threshold, horizon, barrier
width, feature set, symbol universe — is judged by **re-running the full Gate 0 harness**, never by a
single backtest.

- [ ] Given a candidate, when evaluated, then a walk-forward report is committed for it, and it is
      adopted **only if** `medianDailyReturnPercent` exceeds the incumbent's by **≥ 0.01 percentage
      points/day** (a margin, so noise-level "improvements" cannot be adopted) **and**
      `maxDrawdownPercent` does not worsen by more than 20% relative.
- [ ] Given an adopted candidate, when re-run on the 3 held-out symbols from G0.1 with the same fold
      geometry, then it must independently satisfy G0.6 steps 2, 3 and 5 on that untouched universe.
      Failing any of the three rejects it regardless of its pooled result.
- [ ] Given N candidates against the same folds, when one is selected, then the report records
      `candidatesEvaluated: N` and a `candidates[]` entry for **every** candidate including losers,
      with `adopted` set on exactly one.
- [ ] Given more than **10** candidates against one fold set, when an 11th is proposed, then it is
      refused until a fresh held-out re-validation runs — the multiple-comparisons guard.
- [ ] Given a candidate is adopted, when it is deployed live, then the tier resets to the current
      tier's start (a new strategy has no track record at that size).

**Realistic expectation, stated so it is not mistaken for a target:** for a retail scalping system
paying 0.075% round-trip, a validated edge of **0.05%–0.15%/day** would be a genuinely good outcome.
Figures materially above that should be treated as an unfound measurement bug until an independent
path confirms them (§2.5).

---

## 11. Constraints

### 11.1 — Data
- `data/klines/*.json` holds 17,280 5m candles per symbol spanning 2026-07-10T01:35Z →
  2026-09-08T01:30Z (**60.0 days**) for APTUSDT, ARBUSDT, LINKUSDT, OPUSDT, SOLUSDT. Preserved
  unchanged so §2's artifacts stay reproducible; Gate 0 uses `data/klines-365/`.
- File shape: `{ symbol, interval, fetchedAt, source, firstOpenTime, lastOpenTime, candles }`.
- Bybit's public kline endpoint (`https://api.bybit.com/v5/market/kline`) caps at **1,000 candles per
  request** (`scripts/fetch-klines.ts:17`) with 120 ms spacing (`:18`). 365 days at 5m ≈ 105,120
  candles ≈ **106 requests/symbol** ≈ 13 s/symbol; 8 symbols ≈ 2 minutes.
- Bybit may not serve 365 days for younger listings. G0.1 must fail loudly, never truncate silently.
- `data/klines/` is gitignored (`.gitignore:29`); `data/validation/` is **not**, so gate artifacts
  are committable.

### 11.2 — Runtime
- Node with `--experimental-strip-types`. **Source is read at process start — the running bot does
  not pick up edits without a restart.**
- No new runtime dependencies. The harness reuses `src/strategy/training.ts` (G0.2) and
  `runBacktest()`; sign test, median and quantiles are implemented inline.
- `runBacktest()` clears and owns module-level indicator, candle and threshold state for its duration
  (its own doc comment says so), so folds and symbols must be evaluated **sequentially in one
  process** — never in parallel, never concurrently with a live session.
- Walk-forward retrains ~45 times over ~100k candles per fold. Budget **≤ 20 minutes** single-
  threaded; if exceeded, reduce `epochs` before reducing fold count — fold count is the power.

### 11.3 — Cost model
Maker 0.02%/side, taker 0.055%/side. Entries are post-only maker; **exits are always market/taker by
design**, so the round trip is **0.075%**, not 0.04%. Not to be changed without re-running every
gate. The single sanctioned exception is §9.1's slippage term, which explicitly requires that re-run.

### 11.4 — Secrets
`config.json` holds live API credentials and is gitignored (`.gitignore:5`). No gate artifact, report,
log or commit may contain `apiKey`/`apiSecret`. `scripts/backtest.ts` enumerates the config fields it
records explicitly rather than spreading-and-deleting, so a newly added secret field cannot leak by
default; every new artifact writer must follow that pattern.

---

## 12. Out of scope

- **Real capital before §8's go-live criteria are met.**
- **Leverage above 1×** (§9.2).
- Short entries — the model is trained exclusively on long triple-barrier labels.
- Additional model classes (gradient boosting, neural nets). The linear model's limits have not been
  demonstrated *with a trustworthy harness*; adding capacity before Gate 0 exists would fit noise
  faster. Revisit only if §10 plateaus.
- Multi-agent / multi-strategy orchestration.
- Changing the fee model, barrier definitions or feature set **during** Gate 0 — it measures the
  system as it stands. Changes belong in §10; the one cost-model exception is §9.1.
- Dashboard/UI work beyond surfacing the §8.1 kill-switch state.
- Automated deposit or withdrawal handling.
- Any change to `maxCapitalUsd` outside §9's schedule.

---

## 13. Verification gates

- `npm run typecheck` — `tsc --noEmit`, clean.
- `npm run test` — `node --test --experimental-strip-types "tests/*.test.ts"` all green, including a
  new `tests/walkforward.test.ts` covering every G0.5 criterion.
- Evidence regeneration (must reproduce the committed §2 artifacts):
  ```bash
  node --experimental-strip-types scripts/backtest.ts --data data/klines --config ./config.json --held-out 0.25
  node --experimental-strip-types scripts/exit-mix.ts --data data/klines --held-out 0.25
  ```
- Gate 0 (the harness has no default universe, so `--symbols` is required):
  ```bash
  node --experimental-strip-types scripts/walk-forward.ts \
    --data data/klines-365 \
    --symbols APTUSDT,ARBUSDT,LINKUSDT,OPUSDT,SOLUSDT \
    --train-days 30 --test-days 7 --step-days 7
  ```
- **Manual/live step (L-004):** §7's 10-trade mainnet smoke test. No unit test substitutes.
- **Independent critique verdict:** `accepted` at ≥ 20/24 on rubric v2, no dimension at 0.

---

## 14. Assumptions & considered alternatives

- **A-1.** $200/month deposits are assumed steady and treated as exogenous.
- **A-2.** $3,000 is a **capital** target, not a profit target. This spec does not assume the account
  reaches $3,000 by trading.
- **A-3.** Testnet fills approximate mainnet fills. *Assumed, not verified* — and untestable on
  testnet, which is why §7 moved verification to real money at minimum size.
- **A-4.** Gate 0 is run **once** per configuration. Re-running with tweaked parameters until
  `edge_confirmed` appears would invalidate it entirely — p-hacking, and the easiest way to defeat
  this document. §10 is the sanctioned place for variants, with held-out re-validation and the
  10-candidate cap as guards.
- **A-5 (deferred, L-010).** *"Leverage big opportunities at some point"* — a regime-triggered
  high-conviction mode sized above baseline. Deferred, not rejected: it needs a validated baseline
  edge to deviate *from*, and a definition of "big opportunity" measurable ex ante rather than
  obvious in hindsight. Revisit as its own spec after T4 + 90 days.
- **A-6 (deferred).** Moving from 5m bars to true tick/trade data. Would likely improve the
  order-flow features materially (the current 5 are OHLC *proxies*; genuine order-flow imbalance was
  researched and refuted as computable from OHLC). Deferred: large infrastructure change, and Gate 0
  must first establish whether the existing signal is worth improving.
- **A-7.** Symbols share one capital denominator in `netReturnPercent`. This is the pessimistic
  reading and matches how the live bot is funded — one pool serves every symbol.
- **A-8 (rejected alternative).** A 30-day testnet soak before real money, required by revision 2 of
  this spec. Rejected in §7.1: testnet's synthetic fills make it simultaneously the slowest and least
  informative gate, and it cannot test the one assumption (A-3) that needs testing.

---

## 15. Open questions

- **Q-1.** Does Bybit serve a full 365 days of 5m klines for all 8 symbols? Resolved empirically by
  G0.1, which fails closed. If a symbol falls short, the resolution is recorded here — either drop it
  from the universe, or shorten **every** symbol to the common span so folds stay aligned. Unequal
  per-symbol spans are **not** an option: `buildFolds` would produce different fold counts per symbol
  and silently weight the pooled result toward whichever has the most history.
- **Q-2.** Pooled folds across symbols or per-symbol then aggregated? **Resolved: pooled for
  training, with per-symbol P&L always reported** (`pnlBySymbol`, `topSymbolProfitShare`) and
  enforced by G0.6 step 5 — F0 is the failure mode this must catch.
- **Q-3.** Is 30/7/7 the right fold geometry? A 30-day training window is short for a 21-feature
  model; expanding-window uses more data but mixes regimes. **Recommendation: report both, gate on
  rolling 30-day**, the more pessimistic test of regime robustness.
- **Q-4.** *Resolved.* The demotion threshold is `foldDrawdownP90` from the Gate 0 report (§9), not a
  hand-picked number.
- **Q-5.** What is the right resume policy after §8.1's permanent halt? Currently "explicit config
  change." An alternative is requiring a fresh Gate 0 run. Deferred until the halt actually fires.
