# Freqtrade cross-check

An independent second opinion on our backtest engine, using
[freqtrade](https://github.com/freqtrade/freqtrade) (54.2k stars, 32k commits) as the reference
implementation.

## Why

This project found **eight measurement artifacts in one day**
(`specs/profit-target-roadmap.md` §2.5). Every one of them inflated results, and the two worst were
backtest/live divergences in the execution layer — including `executor.ts` stamping fills with
`Date.now()`, which silently disabled the horizon exit in *every backtest ever run* while it worked
fine live.

Gate 0 then returned `no_edge` from that same engine. Before accepting a verdict that shapes whether
real money is ever committed, it is worth knowing whether the machinery producing it is sound.

## What is actually being compared

**Not** a reimplementation of the strategy. Our entry rule is a rule-based score
(RSI/MACD/Bollinger/momentum/volume/SMA) **and** a cost gate **and** a 21-feature logistic model
**and** an N-tick confirmation streak. Rebuilding all of that in pandas would add more divergence
risk than the exercise removes, and any mismatch would be uninterpretable — you would not know which
side was wrong.

Instead, **our engine exports its entry decisions and freqtrade replays them.** Freqtrade then
applies its own execution: fill prices, stop-loss, ROI exit, the 4h horizon exit, fee accounting,
P&L, drawdown.

| | Validated by this cross-check |
|---|---|
| Entry fill timing and price | ✅ |
| Stop-loss trigger + fill | ✅ |
| Take-profit trigger + fill | ✅ |
| Horizon / time-based exit | ✅ (the exit path that was broken) |
| Fee accounting, both legs | ✅ |
| P&L arithmetic | ✅ |
| **Signal generation** | ❌ — shared, not reimplemented |
| **Feature computation** | ❌ — covered by `tests/walkforward.test.ts::no-lookahead` |

Stating the boundary is the point. A cross-check with vague scope is worth very little.

## Design decisions that make the comparison valid

- **No timestamp shift.** Our engine fills at the signal bar's *close*; freqtrade fills at the
  *next* bar's *open*. Verified equal on all 105,120 candles in the dataset (`close[N] == open[N+1]`,
  0 exceptions), so the entry prices coincide exactly.
- **Post-only entries disabled on both sides.** Freqtrade does not model a resting bid the way
  `runBacktest` does; leaving it on would make the fill model dominate the diff.
- **Maker fee == taker fee (0.055%/side).** One rate per side, matching freqtrade's single `fee`
  setting exactly.
- **Absolute probability gate, not percentile.** A percentile threshold recalibrates from whatever
  window it is handed, which is not portable between engines.
- **5m time bars, horizon 48 bars (4h).** Freqtrade is time-bar native. The deployed model uses 7
  dollar bars at a measured 35.0 min/bar = 4h05m, so 48 five-minute bars is the closest equivalent.
  A separate walk-forward on 5m time bars gave −0.1744%/day against −0.1840%/day for dollar bars, so
  the bar type is not load-bearing and this substitution does not change what is being tested.
- **Compare gross return % and exit reason, never dollars.** The engines size positions differently
  (ours risk-based per symbol against its own $100; freqtrade a flat stake against a shared wallet),
  so absolute P&L would differ for reasons that say nothing about correctness.

## Running it

Freqtrade needs `pip`, which this machine does not have. One-time system setup:

```bash
sudo apt install -y python3-pip python3.14-venv
```

Then:

```bash
python3 -m venv crosscheck/.venv
crosscheck/.venv/bin/pip install -U pip freqtrade
```

Generate our side and the freqtrade inputs:

```bash
node --experimental-strip-types scripts/crosscheck-export.ts --data data/klines-365 --symbols APTUSDT,ARBUSDT,LINKUSDT,OPUSDT,SOLUSDT --train-start 2025-09-10 --train-days 90 --test-days 90
```

```bash
python3 crosscheck/prepare.py
```

Run freqtrade's backtest over the same window:

```bash
cd crosscheck && .venv/bin/freqtrade backtesting --config freqtrade-config.json --strategy CrossCheckReplay --strategy-path user_data/strategies --datadir user_data/data --timerange 20251209-20260309 --export trades
```

Compare:

```bash
python3 crosscheck/compare.py
```

`compare.py` exits 0 if the engines agree on every trade's entry bar, exit reason, and gross return
(within 0.05 pp), and 1 if they disagree.

## Interpreting the result

- **Agree** → the execution/accounting layer is independently corroborated, and Gate 0's `no_edge`
  verdict stands on validated machinery.
- **Disagree** → one engine has a bug. Neither engine's numbers should be trusted until it is found.
  Given this project's record, our engine is the more likely culprit, but freqtrade is not immune —
  its own docs warn that `lookahead-analysis` produces false positives in some configurations.

## Files

| File | Purpose |
|---|---|
| `../scripts/crosscheck-export.ts` | Trains one model, runs our engine, exports decisions + trades |
| `prepare.py` | Converts klines to freqtrade OHLCV, emits `entry_signals.json` |
| `user_data/strategies/CrossCheckReplay.py` | Replays our entries; computes no indicators of its own |
| `freqtrade-config.json` | Freqtrade config. Named to avoid `.gitignore`'s blanket `config.json` rule; contains no credentials |
| `compare.py` | Trade-by-trade diff, exits non-zero on disagreement |
