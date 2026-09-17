# Fundamental (catalyst) analysis for this system — method reference

Scope: crypto perpetuals, 1–10 day holding horizon, decisions once per day at 00:15 UTC from a
point-in-time snapshot. "Fundamental" here means **catalysts and flows that move price over days**,
not valuation. Every claim of edge maps to a `specs/daily-catalyst-manual-trading.md` §2.2 row; the
strength column there is the ceiling of any confidence expressed.

## 1. Catalyst families

| Family | What moves price | Features | Evidence (strength) | Invalidates when | Known failure modes |
|--------|------------------|----------|---------------------|------------------|---------------------|
| Flows | Net buying via spot ETFs; stablecoin supply as dry powder | `btcEtfNetFlowUsd1d/5d`, `ethEtfNetFlowUsd1d`, `stablecoinSupplyChange7dPct` | X1 (Moderate), X9/X10 (Docs) | Flow sign flips; supply contracts | Same-day flow is coincident (X1): flows chase price as often as they lead it. Farside rows depend on the CSV import |
| Positioning / leverage | Crowded longs or shorts unwind; funding is the price of the crowd | `fundingRate8hAvg3d`, `fundingRatePercentile90d`, `oiChange3dPct` | X4 (Weak/mixed), X6/X7 (Docs) | Percentile normalises; OI resets | No out-of-sample confirmation (X4). Rising OI into a falling price can be shorts, not "late longs" |
| Macro calendar | Volatility clusters around FOMC / CPI | `hoursToNextFomc`, `hoursToNextCpi` | X2 (Moderate), X8 (Docs) | Event passes | Supports risk timing, not direction (X2). CPI dates come from FRED; missing feature = unknown risk, not "no event" |
| Supply | Token unlocks add sellable float | `daysToNextUnlock`, `nextUnlockPctOfFloat` | X3 (Weak), X5 (Verified example) | Unlock date passes; schedule revised | Front-loaded 14–30 days before, likely arbitraged (X3). Vendors disagree and revise after the fact (X5) |
| Sentiment / liquidity | Extremes mean-revert; realised vol sizes the stop | `fearGreed`, `realizedVol7d`, `atr14d`, `return1d/7d` | X11 (Docs); no edge row | Reading normalises | `no evidence in §2.2` for direction; use for sizing and context only |

## 2. What a complete thesis contains

1. **Catalyst**: which family, which feature reading today (value, verbatim from the report).
2. **Mechanism**: who has to buy or sell because of it, over what window.
3. **Timing**: why the next 1–10 days, and what on the calendar sits inside that window.
4. **Invalidation**: the feature condition that proves the thesis wrong (this becomes `invalidateWhenAny`).
5. **Evidence**: the §2.2 ID and strength; if none, say `no evidence in §2.2`.
6. **What is missing**: features `missing` in the report that would normally bear on it.
7. **Gate status**: D0 owed unless `forwardOnly`; D1 owed before any leverage; live closed-trade count.

A thesis missing items 1, 4 or 5 is not a thesis; say so.

## 3. Order of examination when reading a report

1. `completeness`, `sources`, and missing features: what cannot be known today.
2. `breaker` and `openTradeThesis`: is the account allowed to add, and are open theses intact.
3. Positioning family first: is the trade crowded (percentile > 90 or < 10) or clean.
4. Calendar: any FOMC / CPI inside the holding window.
5. Catalyst families with a triggered rule or an AI idea; check each cited feature against §2.2.
6. Sentiment and vol: sizing context only.
7. News (see `news-protocol.md`): what changed since the snapshot, tagged and cited.

## 4. Errors to name explicitly

- Coincident vs predictive: a correlation on the same day is not a forward signal (X1).
- Look-ahead: "unlocks dumped last time" or "CPI days were bullish" from memory is contaminated (X13); only Gate D0 on this system counts.
- Narrative drift: a number that appears in a news page but not in the report is unverified; the report's feature wins for levels, always.
- Vendor disagreement: unlock dates and sizes differ by source (X5); state the disagreement rather than picking one.
- Volatility is not direction (X2): an event-vol window argues for a smaller stop distance in R terms, not for a side.
- Confidence inflation: never express more conviction than the weakest link in the chain (evidence strength, data completeness, gate status).
