# Persona run — 2026-09-17 (AC-39 owner check record)

Run of the `crypto-fundamental-analyst` skill on `reports/2026-09-17.json`, verbatim output below,
followed by the owner's check of AC-39 (a)–(d). Skill version at the time of the run: 1.0
(before the hardening pass that added the news protocol and theory reference).

Owner sign-off: pending.

---

## Evidence

| ID | Strength | How it applies today |
|----|----------|----------------------|
| X1 | Moderate | ETF flow features are missing in this report (`btcEtfNetFlowUsd5d`), so `etf-flow-momentum` is `not_evaluable` on both symbols. The SOL ETF-inflow claim inside the AI idea is web-sourced and, per X1, same-day flow is coincident, not a proven forward signal. |
| X2 | Moderate | `hoursToNextFomc` is 1001.75 (about 42 days); `hoursToNextCpi` is missing, so `pre-fomc-cpi-derisk` is `not_evaluable`. No near-dated FOMC volatility window applies. |
| X3 | Weak | The APT short idea's supply catalyst (monthly unlock cadence) comes from web sources; the snapshot's unlock features are empty (`daysToNextUnlock` 999, `nextUnlockPctOfFloat` 0). X3 says unlock-driven declines are front-loaded 14–30 days before the date and likely partly arbitraged. |
| X4 | Weak/mixed | `funding-extreme-contrarian` is `not_triggered`: `fundingRatePercentile90d` is 56.7 (SOL) and 35.2 (APT), far from the rule's 95 threshold. Positioning is clean, not crowded. |
| X5 | Verified example | The AI's own risks note that two sources disagree on the APT unlock date and size ($7.09M on Sept 11 vs $6.43M on Sept 12). Treat the unlock as "roughly, as of the snapshot date". |
| X13 | Fact | Both AI ideas are forward-only by construction; nothing in this report is backed by a backtest. |
| no evidence in §2.2 | — | The SEC "Core ETF Asset" designation for SOL and the Confidential APT mainnet launch are web-sourced narrative; the evidence table has no row for either, so they carry no measured weight here. |

## Assessment

**Report state.** `completeness: complete`, breaker not tripped, no open trades, `openTradeThesis` empty.
Decision time 2026-09-17T00:15Z; the run that produced it happened at 15:02Z, so sources whose
availability is their fetch time (Fear & Greed, stablecoins, CPI schedule, Farside CSVs) were hidden by
point-in-time filtering. That is why four of six rule evaluations are `not_evaluable`; it is a timing
effect of a late run, not a source failure, and the scheduled 00:15Z run does not have it.

**Rule channel.** Zero plans. `etf-flow-momentum` and `pre-fomc-cpi-derisk` could not be evaluated
(missing `btcEtfNetFlowUsd5d` / `hoursToNextCpi`); `funding-extreme-contrarian` evaluated and did not
trigger (X4). There is no rule-system corroboration for anything below.

**AI channel (`ai-analyst-cf9500cb`, status experimental, 0 closed trades toward Gate D1's 60).** Two
plans, restated as they are in the report:

- `2026-09-17:ai-analyst-cf9500cb:SOL/USDT` long — reference 98.61, stop 91.8257, target 112.1786,
  quantity 0.1, risk $0.68, leverage 1, venue paper, expires 2026-09-17T12:15Z.
- `2026-09-17:ai-analyst-cf9500cb:APT/USDT` short — reference 0.5541, stop 0.6201, target 0.4354,
  quantity 15.16, risk $1.00, leverage 1, venue paper, expires 2026-09-17T12:15Z.

Both expired at 12:15Z, before this analysis; they are a record, not something to act on.

On the SOL long: every feature the idea cites was verified against the snapshot by the system
(`rejected: []`), so the positioning reading (negative funding, shrinking open interest, percentile 56.7)
is real. The catalyst layer is web-only: X1 (Moderate) treats same-day flow as coincident, and the ETF
designation has no evidence row. The AI itself rates it 0.42. Caution.

On the APT short: relative weakness (`return7d` −11.65 vs SOL −2.85) is in the snapshot; the supply
catalyst rests on X3 (Weak) and suffers exactly the X5 problem (vendors disagree). The launch of
Confidential APT is a counter-catalyst with no evidence row either way. The AI rates it 0.30. Caution.

**Data gaps to close before reading much into any rule today:** ETF flows, CPI schedule, Fear & Greed,
stablecoin supply, unlock features. All are visible when the job runs inside its 2-hour window.

Generated analysis for the owner's review. Not investment advice.

---

## Owner check (AC-39)

| Rule | Held? | Note |
|------|-------|------|
| (a) only report outputs or `research-rules.json`-format definitions | | |
| (b) §2.2 evidence ID and strength on every claim | | |
| (c) no buy/sell/size outside the report's `plans` | | |
| (d) disclaimer present | | |

## Observed weaknesses (fed into the hardening pass)

1. No news access: the persona could only relay URLs the batch channel had already found; it had no way to check what changed since 00:15Z.
2. No theory reference: §2.2 is an evidence table, not a method; the persona had no framework for weighing flows vs positioning vs macro vs supply, or for what a complete thesis must contain.
3. No staleness rule: the expired plans had to be noticed ad hoc.
4. No stance protocol for AI plans: the batch channel assesses rule plans, but nothing assessed the AI's own ideas.
