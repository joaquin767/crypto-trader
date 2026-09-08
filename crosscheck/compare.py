#!/usr/bin/env python3
"""Compare freqtrade's backtest result against the TypeScript engine's.

Run after:
  1. node --experimental-strip-types scripts/crosscheck-export.ts ...
  2. python3 crosscheck/prepare.py
  3. freqtrade backtesting --config crosscheck/freqtrade-config.json \
       --strategy CrossCheckReplay --export trades \
       --timerange <start>-<end>

Compares, per trade, the things that are engine-independent:
  - trade count
  - which bars were entered (should be identical by construction)
  - exit reason
  - GROSS return %, entry to exit, fees excluded

Absolute P&L is deliberately NOT compared: the two engines size positions
differently (ours risk-based per symbol against its own $100, freqtrade a flat
stake against a shared wallet), so dollars would differ for reasons that say
nothing about correctness.

Exit codes: 0 = engines agree, 1 = they disagree, 2 = could not run.
"""
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MANIFEST = os.path.join(REPO, "data/validation/crosscheck/manifest.json")
RESULTS_DIR = os.path.join(HERE, "user_data/backtest_results")

# How closely the two engines must agree on a single trade's gross return
# before it counts as a match. 0.05 percentage points is far tighter than any
# real modelling difference and far looser than float noise.
TOLERANCE_PCT = 0.05


def pair_to_symbol(pair: str) -> str:
    return pair.split(":")[0].replace("/", "").replace("_", "")


def load_freqtrade_trades():
    """Read the newest freqtrade backtest export via freqtrade's own loader.

    Not by parsing the export directly: freqtrade 2026.8 writes a .zip whose
    internal layout is its business, and `.last_result.json` is only a pointer
    to the newest one. Using load_backtest_data() means this comparison cannot
    drift out of sync with the archive format — and an earlier hand-rolled
    reader silently picked up the pointer file and reported "0 freqtrade
    trades", which looks identical to a real disagreement.

    Requires the venv python: crosscheck/.venv/bin/python crosscheck/compare.py
    """
    try:
        from freqtrade.data.btanalysis import load_backtest_data
    except ImportError:
        print(
            "freqtrade is not importable — run this with the venv python:\n"
            "  crosscheck/.venv/bin/python crosscheck/compare.py",
            file=sys.stderr,
        )
        return None
    from pathlib import Path

    if not os.path.isdir(RESULTS_DIR):
        print(f"No freqtrade results at {RESULTS_DIR}", file=sys.stderr)
        return None
    df = load_backtest_data(Path(RESULTS_DIR))
    return df.to_dict("records"), RESULTS_DIR


def main() -> int:
    if not os.path.exists(MANIFEST):
        print(f"missing {MANIFEST} — run scripts/crosscheck-export.ts first", file=sys.stderr)
        return 2

    with open(MANIFEST) as f:
        manifest = json.load(f)

    loaded = load_freqtrade_trades()
    if loaded is None:
        return 2
    ft_trades, _ = loaded

    # ── index both sides by (symbol, entry bar ms) ───────────────────────
    ours = {}
    for symbol, trades in manifest["ourTrades"].items():
        for t in trades:
            ours[(symbol, t["entryTime"])] = t

    theirs = {}
    for t in ft_trades:
        symbol = pair_to_symbol(t["pair"])
        # freqtrade reports open_timestamp in ms at the fill bar, which is the
        # bar AFTER the signal bar. Our entryTime is the signal bar. Shift back
        # one 5m bar to line them up.
        entry_ms = int(t["open_timestamp"]) - 5 * 60 * 1000
        theirs[(symbol, entry_ms)] = t

    print(f"\n  our engine : {len(ours)} trades")
    print(f"  freqtrade  : {len(theirs)} trades")

    only_ours = set(ours) - set(theirs)
    only_theirs = set(theirs) - set(ours)
    both = set(ours) & set(theirs)

    print(f"  matched    : {len(both)}")
    if only_ours:
        print(f"  ONLY ours  : {len(only_ours)}")
        for k in sorted(only_ours)[:5]:
            print(f"      {k[0]} @ {k[1]}")
    if only_theirs:
        print(f"  ONLY freqtrade: {len(only_theirs)}")
        for k in sorted(only_theirs)[:5]:
            print(f"      {k[0]} @ {k[1]}")

    # ── per-trade agreement ──────────────────────────────────────────────
    ret_mismatch = []
    reason_mismatch = []
    reason_pairs = Counter()

    # freqtrade exit reason -> our ExitReason
    REASON_MAP = {
        "roi": "take_profit",
        "stop_loss": "stop_loss",
        "trailing_stop_loss": "stop_loss",
        "custom_exit": "horizon",
        "exit_signal": "horizon",
        "force_exit": "horizon",
    }

    for k in sorted(both):
        o, t = ours[k], theirs[k]
        # freqtrade profit_ratio is NET of fees; add them back for a gross
        # comparison, since our grossReturnPercent excludes fees.
        fee_pct = manifest["strategy"]["feePercentPerSide"] / 100.0
        ft_gross = (t["profit_ratio"] + 2 * fee_pct) * 100
        if abs(ft_gross - o["grossReturnPercent"]) > TOLERANCE_PCT:
            ret_mismatch.append((k, o["grossReturnPercent"], ft_gross))

        mapped = REASON_MAP.get(t.get("exit_reason", ""), t.get("exit_reason", "?"))
        reason_pairs[(o["exitReason"], mapped)] += 1
        if mapped != o["exitReason"]:
            reason_mismatch.append((k, o["exitReason"], t.get("exit_reason")))

    print(f"\n  gross-return mismatches (> {TOLERANCE_PCT} pp): {len(ret_mismatch)}")
    for k, a, b in ret_mismatch[:10]:
        print(f"      {k[0]:9} @ {k[1]}  ours {a:+.3f}%  ft {b:+.3f}%  diff {b-a:+.3f}pp")

    print(f"  exit-reason mismatches: {len(reason_mismatch)}")
    for k, a, b in reason_mismatch[:10]:
        print(f"      {k[0]:9} @ {k[1]}  ours {a}  ft {b}")

    print("\n  exit-reason cross-tab (ours -> freqtrade):")
    for (a, b), n in sorted(reason_pairs.items(), key=lambda x: -x[1]):
        mark = "  " if a == b else "!!"
        print(f"    {mark} {a:14} -> {b:14} {n:>4}")

    agree = (
        not only_ours and not only_theirs
        and not ret_mismatch and not reason_mismatch
    )
    print("\n" + "=" * 66)
    if agree:
        print("  ENGINES AGREE — every trade matches on entry, exit reason and")
        print("  gross return. The TypeScript execution/accounting layer is")
        print("  independently corroborated, so the Gate 0 no_edge verdict")
        print("  stands on validated machinery.")
    else:
        print("  ENGINES DISAGREE — one of them has a bug. Investigate the")
        print("  mismatches above before trusting EITHER engine's numbers.")
    print("=" * 66)
    return 0 if agree else 1


if __name__ == "__main__":
    sys.exit(main())
