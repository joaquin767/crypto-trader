# Decision protocol for the persona (revision 3, Phase 6)

Purpose: `npm run decide` is the only writer of a decision (P9). This file gives the exact JSON
shapes it validates, the exact commands, and the rules that keep one decision one artifact. See
`specs/daily-catalyst-manual-trading.md` §5.15 for the normative contract this summarizes.

## `decide today's plan` — one `DailyDecisionInput` block, one command

```json
{
  "dateUtc": "2026-09-18",
  "choice": { "kind": "report-plan", "planId": "2026-09-18:etf-flow-momentum:BTC/USDT" },
  "stances": [
    { "planId": "2026-09-18:etf-flow-momentum:BTC/USDT", "stance": "support", "reasons": ["ETF flows strongly positive, X1"] },
    { "planId": "2026-09-18:ai-analyst-7d2e1a3f:ETH/USDT", "stance": "caution", "reasons": ["thin evidence for the funding read"] }
  ],
  "news": [{ "title": "BTC ETF inflows accelerate", "url": "https://example.com/etf-flows", "date": "2026-09-17", "tag": "confirmed" }],
  "rationale": "Strongest, best-evidenced plan of the day; ETH idea lacks conviction."
}
```

`choice.kind` is exactly one of:
- `"report-plan"` — `planId` names a `kind:"plan"` entry from today's report (either channel).
- `"persona-idea"` — an `idea` shaped like `AiIdea` (symbol, side, thesis, catalysts, `refs`
  citing only report feature values or URLs a search returned this session, `invalidateWhenAny`,
  `stopAtrMultiple`, `targetRMultiple`, `maxHoldDays`, `confidence`). Never cite a feature value
  that differs from the report's.
- `"no-trade"` — `reason` non-empty.

`stances` needs exactly one entry per `kind:"plan"` plan in today's report, any order — missing
one is rejected (`missing_stance`). Run:

```
npm run decide -- --date <date>
```

On a non-zero exit, the CLI prints every rejection as `<code> <path>: <detail>` — show it verbatim
and emit a corrected block. Never claim the decision is recorded before the CLI exits 0.

## `manage open position` — one `ManageInput` block per trade, one command per trade

```json
{
  "dateUtc": "2026-09-18",
  "tradeId": "7c1f2e3a-...",
  "action": { "kind": "tighten-stop", "price": 59000 },
  "thesis": "intact",
  "reasons": ["price holding above the entry band, no invalidation condition met"],
  "news": []
}
```

`action.kind` is exactly one of `"hold"`, `{"kind":"tighten-stop","price":<number>}`, or
`"close-now"`. `thesis` MUST be copied verbatim from that trade's `openTradeThesis.state` in
today's report — the CLI recomputes it itself and rejects a mismatch (`thesis_mismatch`); never
assert a thesis of your own. Two open positions mean two blocks and two commands:

```
npm run decide -- --mode manage --date <date> --trade <tradeId>
```

Never suggest averaging into or re-entering a position; never propose a stop that widens risk or
crosses the entry; never batch several trades into one block.

## `review closed trade` — one `ReviewInput` block per trade, one command per trade

```json
{
  "dateUtc": "2026-09-18",
  "tradeId": "7c1f2e3a-...",
  "rMultiple": -1.1,
  "exitKind": "stop",
  "followedPlan": true,
  "thesisVerdict": "invalidated",
  "lesson": "Entered at the top of the gap band; next time wait for confirmation."
}
```

`rMultiple`, `exitKind` and `followedPlan` MUST be restated unchanged from the journal's computed
review (`GET /api/review/:tradeId`) — the CLI rejects any of them that don't match exactly
(`out_of_range`). Only `thesisVerdict` (`confirmed` / `invalidated` / `inconclusive`) and `lesson`
are the persona's own judgment. Run:

```
npm run decide -- --mode review --date <date> --trade <tradeId>
```

## Rejection codes (fail closed)

Every rejection prints as `<code> <path>: <detail>`. Common ones: `schema_invalid`,
`date_mismatch`, `unknown_plan`, `not_a_plan`, `expired`, `rule_changed`, `unverifiable_feature`,
`web_only_evidence`, `no_evidence`, `symbol_not_configured`, `out_of_range`, `missing_stance`,
`duplicate_stance`, `empty_reason`, `replan_rejected`, `trade_not_found`, `trade_not_open`,
`trade_not_closed`, `trade_not_planned`, `thesis_mismatch`. `--revise` in modes `plan`/`manage`
additionally exits 5 (`journal_stale: run the journal server sync first`) when the journal's last
sync is missing, unparseable, failed, or older than `manual.staleAfterMs` — start or leave
`npm run journal` running and confirm `GET /api/state` shows `lastSync.status: "ok"`.

## Owner-protocol vocabulary (so chat and the Plan Report agree)

- **Execute window**: `decidedAt` → `decidedAt + persona.executionWindowMs` (default 6h). After
  it closes, do not enter — wait for tomorrow's report.
- **Gap rule**: do not enter if the mark is more than `persona.maxEntryGapAtr × atr14d` away from
  the plan's `referencePrice`.
- **Come back, case 1 (position closed)**: record the exit (paper: `POST /api/paper/exit`; live:
  the sync picks it up), then at the next daily report run `review closed trade` for that trade.
- **Come back, case 2 (position still open)**: at the next daily report, run
  `manage open position` for that trade.
