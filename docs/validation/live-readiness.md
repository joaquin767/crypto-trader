# Live Readiness Log

Evidence for the [Before your first live trade](../DAILY_WORKFLOW.md#before-your-first-live-trade) checklist.
Add one entry per check run, newest last. Never paste API keys or secrets here.

| # | Check | Date (UTC) | Result | Evidence |
|---|-------|-----------|--------|----------|
| 1 | Read-only key syncs mainnet account | 2026-09-16 22:00 | ✅ Pass | `/api/state`: `liveSync: "enabled"`, `lastSync.status: "ok"`, `error: null`, 0 fills / 0 positions (none since `journalStartTime` 2026-09-16T21:50:00Z) |
| 2 | Key with trade permission is refused | — | ⏸ Pending | — |
| 3 | Real fills become the right trade | — | ⏸ Pending | — |
| 4 | Funding sign is correct | — | ⏸ Pending | — |
| 5 | Plan linking on a real position | — | ⏸ Pending | — |
| 6 | Stale data is flagged | — | ⏸ Pending | — |
| 7 | Screenshots saved | — | ⏸ Pending | — |

## Notes

- **2026-09-16 — check 1.** The first mainnet run failed every sync with Bybit `retCode 10001`
  ("symbol or settleCoin" required) because positions were requested unfiltered. Fixed in
  `de22664` (`settleCoin: USDT`); the re-run passed. The failure was handled as designed: sync status
  `failed`, journal unchanged.
- **2026-09-16 — check 1, earlier attempt.** Without `manual.journalStartTime`, the sync made no REST
  calls and reported `manual.journalStartTime not set`, as designed.
