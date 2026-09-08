#!/usr/bin/env python3
"""Convert our kline files into freqtrade's OHLCV format, and emit the entry
signals the freqtrade strategy replays.

Half two of the cross-check described in scripts/crosscheck-export.ts. Run
that first — it writes data/validation/crosscheck/manifest.json, which this
reads.

Freqtrade stores OHLCV as a flat list of
    [timestamp_ms, open, high, low, close, volume]
in user_data/data/<exchange>/<BASE>_<QUOTE>-<timeframe>.json

Only the test window is exported. Freqtrade needs some candles before the
backtest range for its own startup handling, so a small lead-in is included
and the backtest --timerange starts at the real test start.
"""
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(REPO, "data/validation/crosscheck/manifest.json")
KLINES = os.path.join(REPO, "data/klines-365")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_data/data/bybit")

# Candles of lead-in before the test window, so freqtrade has history at the
# left edge. Entry signals never fall inside it, so it cannot add trades.
LEAD_IN_BARS = 500
BAR_MS = 5 * 60 * 1000


def pair_of(symbol: str) -> str:
    """APTUSDT -> APT_USDT (freqtrade's spot pair filename form)."""
    assert symbol.endswith("USDT"), symbol
    return f"{symbol[:-4]}_USDT"


def main() -> int:
    if not os.path.exists(MANIFEST):
        print(f"missing {MANIFEST}\nRun scripts/crosscheck-export.ts first.", file=sys.stderr)
        return 1

    with open(MANIFEST) as f:
        manifest = json.load(f)

    test_start = manifest["window"]["trainEnd"]
    test_end = manifest["window"]["testEnd"]
    lead_start = test_start - LEAD_IN_BARS * BAR_MS

    os.makedirs(OUT, exist_ok=True)
    signals = {}
    total = 0

    for symbol, entry_times in manifest["entrySignals"].items():
        with open(os.path.join(KLINES, f"{symbol}-5m.json")) as f:
            candles = json.load(f)["candles"]

        rows = [
            [c["openTime"], c["open"], c["high"], c["low"], c["close"], c["volume"]]
            for c in candles
            if lead_start <= c["openTime"] < test_end
        ]
        pair = pair_of(symbol)
        path = os.path.join(OUT, f"{pair}-5m.json")
        with open(path, "w") as f:
            json.dump(rows, f)

        # Sanity: every entry signal must land on a bar we actually exported,
        # and inside the test window. A signal that falls outside would be
        # silently dropped by freqtrade and quietly shrink the comparison.
        exported = {r[0] for r in rows}
        missing = [t for t in entry_times if t not in exported]
        outside = [t for t in entry_times if not (test_start <= t < test_end)]
        if missing:
            print(f"  !! {symbol}: {len(missing)} entry signals not in exported candles", file=sys.stderr)
            return 1
        if outside:
            print(f"  !! {symbol}: {len(outside)} entry signals outside the test window", file=sys.stderr)
            return 1

        signals[pair] = sorted(entry_times)
        total += len(entry_times)
        print(f"  {symbol:10} -> {pair:10} {len(rows):>6} candles, {len(entry_times):>3} entry signals")

    sig_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "entry_signals.json")
    with open(sig_path, "w") as f:
        json.dump({
            "note": "Entry bar open-times (ms) chosen by the TypeScript engine. "
                    "The freqtrade strategy replays exactly these and nothing else.",
            "testStart": test_start,
            "testEnd": test_end,
            "strategy": manifest["strategy"],
            "signals": signals,
        }, f, indent=2)

    print(f"\n  {total} entry signals across {len(signals)} pairs")
    print(f"  wrote {OUT}/")
    print(f"  wrote {sig_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
