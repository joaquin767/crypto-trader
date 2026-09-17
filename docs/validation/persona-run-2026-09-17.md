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

---

# Second run — skill 1.1 (hardened), same report, 2026-09-17 ~15:45Z

## Staleness

Report `decisionTime` 2026-09-17T00:15Z; analysis time ~15:45Z (15.5 h later). Both plans carry
`expiresAt` 2026-09-17T12:15Z: **expired**. This is a review of a record, not of something actionable.

## Evidence

| ID | Strength | How it applies today |
|----|----------|----------------------|
| X1 | Moderate | `btcEtfNetFlowUsd5d` missing → `etf-flow-momentum` `not_evaluable`. Same-day flow is coincident, not predictive. |
| X2 | Moderate | `hoursToNextFomc` 1001.75 (next meeting ~Oct 28); `hoursToNextCpi` missing → `pre-fomc-cpi-derisk` `not_evaluable`. Event vol informs risk, not direction. |
| X3 | Weak | APT short's supply catalyst is a monthly unlock; snapshot unlock features are empty (999 / 0). Front-loaded 14–30 days before, likely arbitraged. |
| X4 | Weak/mixed | `funding-extreme-contrarian` `not_triggered`: percentiles 56.7 (SOL), 35.2 (APT). Positioning clean. |
| X5 | Verified example | Unlock date/size disagree across sources ($7.09M Sept 11 vs $6.43M Sept 12). |
| X13 | Fact | AI ideas are forward-only; nothing here is backtested. |
| no evidence in §2.2 | — | SEC "Core ETF Asset" designation (SOL), Confidential APT mainnet, Fed rate decision and the CLARITY Act: narrative, no measured row. |

## News (5 searches; URLs as returned)

| Item | URL | Date | Tag |
|------|-----|------|-----|
| US spot BTC ETFs: net outflow ~$296M on Sept 16, after the Fed raised rates and the Senate stalled the CLARITY Act | https://www.kucoin.com/news/flash/bitcoin-spot-etfs-see-296m-net-outflow-blackrock-s-ibit-leads-with-144m-exit | Sept 16–17 | `unconfirmed` — `btcEtfNetFlowUsd1d` missing in the report; another source attributes $295.98M to Sept 17 and a third reports $746M (vendor disagreement, X5 pattern) |
| Spot BTC ETFs saw $746M outflow "during CLARITY Act and FOMC pressure" | https://www.cryptotimes.io/2026/09/17/spot-bitcoin-etfs-see-746m-outflow-during-clarity-act-and-fomc-pressure/ | Sept 17 | `unconfirmed` — figure conflicts with the $296M reports; no feature to settle it |
| Fed raised rates (FOMC Sept 16) | same KuCoin item | Sept 16 | `confirmed` — consistent with `hoursToNextFomc` 1001.75 pointing at the *next* meeting (~Oct 28); the Sept 16 meeting had passed at decision time |
| Next CPI release: Oct 14, 2026, 8:30 ET (Aug CPI was released Sept 11) | https://www.bls.gov/schedule/ | schedule | `unconfirmed` — `hoursToNextCpi` missing (FRED rows hidden by the late run); this fills the gap for context only, not the feature |
| SOL trades ~$103.29; SEC named SOL a core ETF asset on Sept 5; Transaction V1 launched Sept 9; SOL ETFs +$153.87M (week) | https://coinmarketcap.com/cmc-ai/solana/latest-updates/ , https://cryptorank.io/news/feed/7ea7a-solana-price-prediction-september-2026-network-growth-puts-150-in-focus | Sept 2026 | `contradicts` on price — report `close` 98.61 at 00:15Z wins for levels (the page is later/other venue); catalysts `unconfirmed` |
| Aptos: Confidential APT mainnet Sept 8; unlock 11.31M APT (~0.65% of supply) Sept 11 ($7.09M) / Sept 12 ($6.43M) | https://www.kucoin.com/news/flash/three-major-token-unlocks-to-watch-in-second-week-of-september-2026 , https://coinmarketcap.com/cmc-ai/aptos/latest-updates/ , https://tokenomist.ai/aptos/unlock-events | Sept 8–12 | `contradicts` on unlocks — report `daysToNextUnlock` 999 / `nextUnlockPctOfFloat` 0 say "none known", the schedule says monthly; the report wins for the feature, and `data/manual/unlocks.json` is the owner-maintained gap |

## Assessment

**Order of examination.** Completeness: four rule evaluations `not_evaluable` from the late run; positioning: clean on both names (X4); calendar: FOMC passed Sept 16, next ~Oct 28; CPI Oct 14 — neither inside a 1–10 day window from Sept 17; catalysts: only the AI channel produced anything; sentiment: `fearGreed` missing, realised vol high (SOL 67.3, APT 77.9).

**Rule channel.** No plans; no corroboration.

**AI plan `…:SOL/USDT` long (ref 98.61, stop 91.8257, target 112.1786, qty 0.1, risk $0.68, 1x, paper) — stance: `caution`.**
Cited features verified by the system. Positioning supports it (funding slightly negative, OI shrinking: X4 weak). The catalyst layer (ETF designation, weekly SOL ETF inflows) is `unconfirmed` and, per X1 (Moderate), coincident. The news adds a risk-off backdrop the idea did not have at 00:15Z: a rate hike and two-to-three days of BTC ETF outflows. Thesis checklist: catalyst present, mechanism thin, invalidation only via stop (no feature condition), evidence Moderate at best, data missing (flows, sentiment). Expired anyway.

**AI plan `…:APT/USDT` short (ref 0.5541, stop 0.6201, target 0.4354, qty 15.16, risk $1.00, 1x, paper) — stance: `caution`.**
Relative weakness is in the snapshot (`return7d` −11.65 vs −2.85). The supply catalyst is behind, not ahead: the unlock landed Sept 11–12, and X3 (Weak) says the effect is front-loaded before the date, so the window the thesis needs has largely passed. X5 disagreement stated. Confidential APT (Sept 8) is an `unconfirmed` counter-catalyst. Risk-off backdrop is the one thing in the news that helps a short, and it is BTC-beta, not APT-specific.

**Data gaps, owner-actionable.** (1) `data/manual/unlocks.json` has no APT entry although a monthly schedule is public: add it with the next date and `pctOfCirculating` so `daysToNextUnlock` stops reading 999. (2) The other gaps close when the job runs inside its 2 h window tonight.

**Proposed rule.** Not requested.

Generated analysis for the owner's review. Not investment advice.

## Owner check (AC-39 a–g), second run

| Rule | Held? | Note |
|------|-------|------|
| (a) report outputs / rules-file format only | | |
| (b) §2.2 ID + strength on every claim | | |
| (c) no buy/sell/size outside `plans` | | |
| (d) disclaimer | | |
| (e) news: search-returned URLs only, tagged, feature wins | | |
| (f) staleness stated first | | |
| (g) theory applied, stance on every plan | | |
