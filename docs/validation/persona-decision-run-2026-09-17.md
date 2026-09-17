# Persona decision channel — first end-to-end run (2026-09-17)

Not the AC-116 supervised cycle (that is the owner's, with a real paper entry, a manage call and a
review call over following days). This records the first run of the full chain on real data.

| Step | Result |
|------|--------|
| `config.symbols` | set to `["BTC/USDT","ETH/USDT"]` (A27/A33 accepted by the owner) |
| `npm run research:daily -- --refetch` | report `reports/2026-09-17.r1.json`, 2m02s; AI step via `claude-cli`, list-equivalent $0.41, billed $0 |
| Report | `completeness: incomplete` (`fred-release-dates` network error; ETF-flow, CPI, Fear & Greed, stablecoin features hidden by the 00:15 UTC decision time for a 17:30 UTC run); rules `not_evaluable` ×4, `not_triggered` ×2; AI idea BTC short (confidence 0.32) **rejected by the planner: `size_below_min`** |
| Persona (skill 1.2) | 4 searches, 5 news items tagged; decision `no-trade` with a stated reason; `stances: []` (no `kind:"plan"` plan in the report) |
| `npm run decide -- --date 2026-09-17` | first attempt crashed: `readSnapshots` hashed `ai-analyst.raw.json` as if it were a source snapshot (fixed in `src/research/snapshot-store.ts` + test); second attempt exit 0, but the Plan Report's second clock printed `UTC+0` because `ownerProtocol` is null for a no-trade decision (fixed: `DailyDecision.ownerTimeZone`, test); artifacts regenerated (nothing had been committed or linked) |
| Artifacts | `data/decisions/2026-09-17.json` (skillHash `4b92ab52…`, `validation.ok: true`), `reports/2026-09-17.decision.md` with sections 1 (No trade today), 2 (timeline, both come-back branches, paper-exit step), 4 (empty stance table), 5 (news), 6, 7 (None.) |

## Finding for the owner: minimum lot size vs. the risk budget

The AI's BTC short was rejected as `size_below_min`. With `maxCapitalUsd` $100 and `riskPerTradePercent` 1 the
risk budget is $1 per trade; Bybit's minimum order is 0.001 BTC (≈ $76 notional at 76,170) and 0.01 ETH
(≈ $24 at 2,418). A stop of 1.3 × ATR14d (≈ $2,950 on BTC, ≈ $133 on ETH) makes the risk of the **minimum**
lot ≈ $2.95 (BTC) / ≈ $1.33 (ETH) — both above $1 — so the planner correctly refuses. At this capital and
risk setting, BTC and ETH plans only size when the stop distance is tight (≲ 1.3 % of price on BTC,
≲ 4 % on ETH). This is a config decision for the owner (`riskPerTradePercent`, `maxCapitalUsd`), not a
code defect; the spec's AC-100 example (0.0005 BTC) is below the exchange minimum and is a format fixture only.

Owner sign-off: pending (AC-116 remains open).
