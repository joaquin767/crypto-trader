# AI Analyst Smoke Log — 2026-09-17

Evidence for [AC-54a](../../specs/daily-catalyst-manual-trading.md) (claude-cli provider) — one live
`npm run research:daily` run with `config.ai.enabled: true`, `config.ai.provider: "claude-cli"`. Never
paste API keys, OAuth tokens, or full raw responses here.

| # | Check | Date (UTC) | Result | Evidence |
|---|-------|-----------|--------|----------|
| 1 | Live CLI run completes and structured output parses | 2026-09-17 15:02 | ✅ Pass | `aiAnalyst.status: "ok"`, run took 2m05s |
| 2 | Raw response written | 2026-09-17 15:02 | ✅ Pass | `data/snapshots/2026-09-17/ai-analyst.raw.json`, 46 stdout events |
| 3 | `listCostUsd` recorded (real spend stays 0 under the subscription) | 2026-09-17 15:02 | ✅ Pass | ledger line in `data/ai-usage.jsonl`: `costUsd: 0`, `listCostUsd: 0.4287705` |
| 4 | Owner reads the AI section and signs off | — | ⏸ Pending | — |

## Run detail

- Command: `npm run research:daily` (provider `claude-cli`, model `claude-opus-5`).
- Served by: `claude-opus-5,claude-haiku-4-5-20251001` (the CLI routed one sub-task, likely a web
  search, to the cheaper model — expected per §5.13's `modelUsage` handling).
- Usage: 78 250 input tokens / 9 285 output tokens; 4 web searches.
- Output: 2 verified ideas → 2 `ai-analyst`-origin paper plans; `rejected: []`.
- `promptVersionHash` prefix: `cf9500cb` (rule id `ai-analyst-cf9500cb`).
- Ledger: one line appended to `data/ai-usage.jsonl` (`costUsd: 0`, `listCostUsd: 0.4287705`,
  `resultKind: "ok"`).

## Notes

- **2026-09-17 — timing.** The run was made at 15:02 UTC against the 00:15 UTC decision date. Per
  §5.12's point-in-time rule, this is a late run: sources whose availability is their own fetch time —
  fear & greed, stablecoin supply, the FRED/CPI release schedule, the Farside ETF-flow import — were
  outside their staleness window and showed as `missing` in the features the AI analyst read. This is
  the system working as designed (P2, "point-in-time or it didn't happen"), not a defect; a run closer
  to 00:15 UTC would see those sources populated.
- Owner sign-off (reading the AI section's cited feature values against the report by hand, per §12
  gate 12) is still outstanding — this log records the mechanical/cost facts only.
