# Phase 7 hardening — live smoke (2026-09-17)

Owner-facing record of the three Phase 7 items exercised against real endpoints. AC-133 (the live
Coinalyze call) is covered here; sign-off is the owner's.

## 1. Coinalyze OI (`coinalyze-oi`)

`COINALYZE_API_KEY` set in `~/.config/crypto-trader/secrets.env` (36 chars, file mode 600).

**Defect found and fixed by this smoke run.** The first implementation built symbols as
`BTCUSDT_PERP.6` (assumed from another exchange's docs example). Coinalyze answers **HTTP 200 with
an empty array** for an unknown symbol, so the adapter reported `status: ok` with **0 rows** — a
silent data gap. `GET /v1/future-markets` with a real key shows Bybit's USDT perpetuals are
`BTCUSDT.6` / `ETHUSDT.6` (`is_perpetual: true`, exchange code `6` confirmed via `/exchanges`).

Two fixes:
- `coinalyzeSymbolFor` drops the `_PERP` infix (fixture, tests and §5.16 updated with the live evidence).
- **Fail closed (P1):** a response that does not cover every requested symbol is now `unavailable`
  with a detail naming the missing symbols, never an `ok` snapshot with no rows (new test AC-133a).

After the fix, live call for BTC/ETH: `status ok`, **20 rows** (10 daily per symbol), newest
`observedFor 2026-09-17T00:00:00Z` → `availableAt 2026-09-18T01:00:00Z` (the declared +25 h lag).
BTC daily OI series (contracts): 56305, 56221, 56508, 52700, 53279, 53402, 53988, 56488, 55782, 55651.

## 2. Desktop notification

`notify-send` is installed on this machine. Covered by tests (dep called with the expected args when
`manual.notifyOnReport` or `--notify` is set; not called when disabled; a failure never changes the
exit code). Not yet observed on a real scheduled run — it will fire on tonight's timer run only if
the owner sets `manual.notifyOnReport: true`.

## 3. CSV export of reviews

Journal server started in paper-only mode:

- `GET /api/reviews.csv` → `200`, `content-type: text/csv; charset=utf-8`,
  `content-disposition: attachment; filename="reviews-2026-09-17.csv"`, header row only (the journal
  has no closed trades yet), 23 columns.
- Same endpoint with `Host: evil.example` → `403` (the existing Host check applies).

Owner sign-off: pending.

## 4. Backfill with the new source (and a second defect found)

`npm run backfill -- --from 2024-01-01 --to 2026-09-15`:

| source | rows | coverage |
|---|---|---|
| coinalyze-oi | **1 978** | 2024-01-01 .. 2026-09-15 |
| defillama-stablecoins | 3 215 | 2017-11-29 .. 2026-09-17 |
| bybit-klines-1d / 1h | 9 890 / 237 360 | 2024-01-01 .. 2026-09-15 |
| bybit-funding | 6 000 | 2023-12-23 .. 2026-09-17 |
| farside-btc-etf / eth | 688 / 550 | 2024-01-11 / 2024-07-23 .. 2026-09-16 |
| fred-release-dates | 953 | 1949-03-24 .. 2026-12-10 |
| fear-greed | 3 147 | 2018-02-01 .. 2026-09-17 |

`oiChange3dPct` now has point-in-time history across the whole D0 window, which is the reason this
source exists (previously `bybit-oi` covered only the last ~10 days, so any rule using it was
`forwardOnly`).

**Defect found in the first run of this command.** `defillama-stablecoins` hit a transient network
abort, and `build()` wrote `rows: []` over the existing multi-year history file — a Gate D0 run
would then have read a real data set as an empty one. Fixed: a failed source now **keeps the
previous file untouched** and the summary reports the kept row count with `coverage: "kept previous
file"` (regression test in `tests/backfill-history.test.ts`). The second run restored the file
(3 215 rows above).
