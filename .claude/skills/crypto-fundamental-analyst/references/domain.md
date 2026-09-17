# Domain reference for the crypto-fundamental-analyst persona

Local pointers only. The spec is the source of truth; this file tells the persona where to look.

## Rule definition fields

`src/research/rules.ts` (`RuleDefinition`), validated by `parseRuleSet`:

| Field | Constraint |
|-------|------------|
| `id` | `/^[a-z0-9-]{3,48}$/`, unique |
| `version` | integer >= 1, bump on any change |
| `description` | plain text; say what the rule claims and why |
| `evidence` | §2.2 IDs (`X1`..`X14`); may be empty only when `status` is `experimental` |
| `status` | `experimental` for every new rule; `holdout-passed` / `paper-passed` are set by the owner after Gates D0 / D1 |
| `symbols` | subset of `config.symbols` |
| `side` | `long` or `short` |
| `entryWhenAll` | >= 1 condition `{feature, op, value}`; `op` in `<`, `<=`, `>`, `>=`, `between` (`value` = `[lo, hi]`) |
| `invalidateWhenAny` | conditions re-checked while a trade is open |
| `stopAtrMultiple` | (0, 10] |
| `targetRMultiple` | (0, 20] |
| `maxHoldDays` | integer 1..10 |
| `forwardOnly` | `true` when a feature has no point-in-time history (spec §10.3) |
| `origin` | always `rules-file` here; `ai-analyst` rules are built only by the AI channel |

## Feature names

Defined in `src/research/types.ts` (`FeatureName`) and explained in `docs/DAILY_WORKFLOW.md` "Features reference": `close`, `return1d`, `return7d`, `atr14d`, `realizedVol7d`, `fundingRate8hAvg3d`, `fundingRatePercentile90d`, `oiChange3dPct`, `btcEtfNetFlowUsd1d`, `btcEtfNetFlowUsd5d`, `ethEtfNetFlowUsd1d`, `stablecoinSupplyChange7dPct`, `fearGreed`, `hoursToNextFomc`, `hoursToNextCpi`, `daysToNextUnlock`, `nextUnlockPctOfFloat`.

## Evidence table

`specs/daily-catalyst-manual-trading.md` §2.2, rows `X1`..`X14`, each with a Strength column. Quote the ID and strength; do not paraphrase a strength upward.

## Report shape

`specs/daily-catalyst-manual-trading.md` §5.6 (`DailyReport`): `sources`, `completeness`, `breaker`, `outcomes`, `plans` (rule plans first, then AI plans, split by `origin`), `openTradeThesis`, `aiAnalyst`, `disclaimer`.

## Gates a rule owes before real capital

`specs/daily-catalyst-manual-trading.md` §8: Gate D0 (historical holdout, `npm run backtest:daily -- --rule <id> --mode d0-holdout`) unless `forwardOnly`; then Gate D1 (forward paper, `--mode d1-check`); the leverage ladder only after D1. The persona never changes a rule's `status`.
