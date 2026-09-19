# Rule geometry — measured fix (2026-09-19)

## The defect

`stopAtrMultiple × targetRMultiple` is the target's distance in ATRs; `maxHoldDays` is the time the
market has to travel it. Nothing validates that pairing, and all three example rules asked for
distances the market does not deliver in the time allowed. Measured on the backfilled daily bars
(2024-01-01 → 2026-09-15, BTC/USDT and ETH/USDT, ~970 windows per symbol):

| Rule (before) | Target distance | Hold | Reached (BTC / ETH) |
|---|---|---|---|
| `etf-flow-momentum` — stop 2 ATR × 3R | 6.0 ATR | 5 d | 1.1% / 1.5% |
| `pre-fomc-cpi-derisk` — stop 1.5 ATR × 2R | 3.0 ATR | 3 d | 3.1% / 2.9% |
| `funding-extreme-contrarian` — stop 2.5 ATR × 4R | 10.0 ATR | 7 d | **0.0% / 0.0%** |

The funding rule's target was never reached once in 968 windows on either symbol — in 2.7 years. Its
advertised 4R was arithmetically impossible: the only outcomes available to it were a stop-out or a
time exit. This is the defect the persona caught on 2026-09-19 while assessing that day's plan, and
it applied to every rule in the file.

## Measured excursions (favourable move before the hold expires, in ATRs)

| Hold | median | p75 | p90 |
|------|--------|-----|-----|
| 3 days | 0.7 | 1.2 | 2.0 |
| 5 days | 0.9 | 1.6 | 2.6 |
| 7 days | 1.0 | 1.9 | 3.1 |

Adverse excursions are near-symmetric (median ≈ 1.0 ATR over 7 days), so a stop inside ~1 ATR is hit
by ordinary noise.

## The fix (version 2 of each rule)

Target = the measured **p75** favourable move for that rule's side and hold — reached from a *random*
entry about a quarter of the time, so a rule with a real edge should beat it. Stop ≈ p55–p60 adverse.

| Rule | Stop | Target | Distance | Reached (BTC / ETH) |
|---|---|---|---|---|
| `etf-flow-momentum` | 1.0 ATR | 1.6R | 1.60 ATR in 5 d | 24.6% / 24.6% |
| `pre-fomc-cpi-derisk` | 0.8 ATR | 1.5R | 1.20 ATR in 3 d | 25.5% / 24.5% |
| `funding-extreme-contrarian` | 1.2 ATR | 1.67R | 2.00 ATR in 7 d | 23.1% / 25.1% |

## Dev backtests after the fix (no holdout budget spent)

| Rule | Trades | Mean R | CI90 | p (random timing) | Max DD |
|---|---|---|---|---|---|
| `etf-flow-momentum` | 196 | **+0.025** | [−0.121, 0.171] | 0.50 | 25.4R |
| `pre-fomc-cpi-derisk` | 239 | −0.017 | [−0.143, 0.105] | 0.557 | 29.6R |
| `funding-extreme-contrarian` | 60 | −0.256 | [−0.499, −0.002] | 0.897 | 18.3R |

**Still no edge.** Reachable targets produce far more trades (196 / 239 / 60 versus 73 / 128 / 29 on
the old geometry and the old symbol set), and the two long rules now sit near zero instead of clearly
negative — but every CI90 spans zero or sits below it, and no rule beats its random-timing control
(p 0.50, 0.56, 0.90). The funding rule is the worst of the three and its CI90 is entirely negative:
fading a *relative* funding percentile loses money consistently in this window, which is what X4
(Weak/mixed) already warned.

These remain **example fixtures**. The fix makes their arithmetic honest, not profitable.
