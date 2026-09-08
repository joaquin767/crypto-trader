#!/usr/bin/env python3
"""AUC feasibility test — specs/profit-target-roadmap.md §5.12.3.

THE QUESTION
    Can ANY model on freely-available data reach out-of-sample AUC >= 0.58
    on the deployed label? Below that, §5.12's arithmetic says no barrier,
    gate or cost structure can make this strategy profitable — so this is
    the cheap go/no-go gate that stands between here and a weeks-long
    tick-data infrastructure project.

WHAT IS HELD FIXED
    The triple-barrier label (TP 1.5% / SL 1.5% / horizon 7 dollar bars) and
    the 47 walk-forward folds, both identical to Gate 0's. AUC is only
    comparable across models predicting the SAME label, so only FEATURES and
    MODEL CLASS vary. Features come from scripts/export-folds.ts — the same
    validated TypeScript extractFeatures() the live engine uses, not a pandas
    reimplementation.

DISCIPLINE (same protocol as scripts/barrier-sweep.ts)
    Candidates are pre-registered below with a hypothesis each, capped at 10,
    and all are reported including losers. Selection happens ONLY on the five
    training symbols. The held-out universe (AVAXUSDT/DOTUSDT/INJUSDT) is not
    touched here — it is spent once, on the winner, and only if one clears.

Run with the venv python:
    crosscheck/.venv/bin/python scripts/auc_feasibility.py
"""
import json
import os
import sys
import statistics as st

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOLDS = os.path.join(REPO, "data/validation/folds")
TARGET = 0.58          # §5.12: the AUC that affords a comfortable margin at top-5%
INCUMBENT = 0.546      # Gate 0's measured median fold AUC
SEED = 12345           # fixed: a candidate must not win by re-rolling


def block_slice(names, blocks):
    """Column indices for the requested feature blocks."""
    base = [i for i, n in enumerate(names) if i < 21]
    ctx = [i for i, n in enumerate(names) if n in
           ("ret24", "ret48", "ret96", "volRatio", "distSma50Atr", "distSma100Atr", "rangePos96")]
    btc = [i for i, n in enumerate(names) if n in
           ("btcRet1", "btcRet6", "btcRet24", "btcCorr48", "residRet6")]
    out = []
    for b in blocks:
        out += {"base": base, "ctx": ctx, "btc": btc}[b]
    return sorted(set(out))


# ── PRE-REGISTERED CANDIDATES ────────────────────────────────────────────
# Each states what it tests. A candidate without a hypothesis is a grid cell,
# which is the thing this protocol exists to avoid.
CANDIDATES = [
    ("logistic-base", ["base"], "logistic",
     "SANITY CHECK: must reproduce Gate 0's ~0.546. If it does not, the export "
     "or this harness is wrong and every number below is meaningless."),
    ("logistic-ctx", ["base", "ctx"], "logistic",
     "Does longer context help a LINEAR model? The 21 base features look back "
     "~30 bars to answer a 4-hour-ahead question."),
    ("logistic-btc", ["base", "btc"], "logistic",
     "Does the BTC market factor help? This is the only genuinely NEW "
     "information in the test — not derivable from the symbol's own OHLC at "
     "any lookback."),
    ("logistic-all", ["base", "ctx", "btc"], "logistic",
     "Both feature blocks, still linear. Isolates information gain from model "
     "capacity."),
    ("gbm-base", ["base"], "gbm",
     "Does NON-LINEARITY help on the existing features? Interactions between "
     "RSI, volatility and volume are plausible and a linear model cannot see "
     "them. This is the single largest untested lever."),
    ("gbm-all", ["base", "ctx", "btc"], "gbm",
     "Capacity AND information together — the best realistic combination of "
     "everything obtainable for free."),
    ("gbm-all-deep", ["base", "ctx", "btc"], "gbm-deep",
     "More capacity still. If this beats gbm-all the binding constraint was "
     "capacity; if it does not (or overfits), the constraint is INFORMATION, "
     "which is the finding that matters for the infrastructure decision."),
    ("rf-all", ["base", "ctx", "btc"], "rf",
     "A different non-linear family, as a check that any gain is not an "
     "artifact of one algorithm's inductive bias."),
]


def make_model(kind):
    if kind == "logistic":
        return make_pipeline(StandardScaler(),
                             LogisticRegression(max_iter=2000, C=1.0, random_state=SEED))
    if kind == "gbm":
        return HistGradientBoostingClassifier(
            max_iter=200, learning_rate=0.05, max_depth=3,
            l2_regularization=1.0, random_state=SEED)
    if kind == "gbm-deep":
        return HistGradientBoostingClassifier(
            max_iter=500, learning_rate=0.05, max_depth=6,
            l2_regularization=0.5, random_state=SEED)
    if kind == "rf":
        return RandomForestClassifier(
            n_estimators=300, max_depth=8, min_samples_leaf=50,
            n_jobs=-1, random_state=SEED)
    raise ValueError(kind)


def main() -> int:
    if not os.path.isdir(FOLDS):
        print(f"missing {FOLDS} — run scripts/export-folds.ts first", file=sys.stderr)
        return 2
    with open(os.path.join(FOLDS, "manifest.json")) as f:
        manifest = json.load(f)
    names = manifest["featureNames"]

    files = sorted(f for f in os.listdir(FOLDS) if f.startswith("fold-"))
    folds = []
    for fn in files:
        with open(os.path.join(FOLDS, fn)) as f:
            d = json.load(f)
        if len(d["ytr"]) < 500 or len(d["yte"]) < 50:
            continue
        if len(set(d["yte"])) < 2:      # a fold with one class has no defined AUC
            continue
        folds.append((np.asarray(d["Xtr"], dtype=np.float64), np.asarray(d["ytr"]),
                      np.asarray(d["Xte"], dtype=np.float64), np.asarray(d["yte"])))

    print(f"AUC feasibility test — target {TARGET}, incumbent {INCUMBENT}")
    print(f"  label FIXED: TP {manifest['tp']}% / SL {manifest['sl']}% / horizon {manifest['horizon']} bars")
    print(f"  {len(folds)} usable folds, {len(names)} feature columns available")
    print(f"  symbols: {', '.join(manifest['symbols'])}  (held-out universe NOT touched)\n")

    results = []
    for label, blocks, kind, hypothesis in CANDIDATES:
        cols = block_slice(names, blocks)
        aucs = []
        for Xtr, ytr, Xte, yte in folds:
            m = make_model(kind)
            m.fit(Xtr[:, cols], ytr)
            p = m.predict_proba(Xte[:, cols])[:, 1]
            aucs.append(roc_auc_score(yte, p))
        med = st.median(aucs)
        results.append({
            "label": label, "blocks": blocks, "model": kind, "hypothesis": hypothesis,
            "nFeatures": len(cols), "medianAuc": med, "meanAuc": st.mean(aucs),
            "stdevAuc": st.stdev(aucs), "foldsAtOrAboveTarget": sum(1 for a in aucs if a >= TARGET),
            "totalFolds": len(aucs), "aucs": aucs,
        })
        print(f"  {label:16} {len(cols):>3}f  median {med:.4f}  mean {st.mean(aucs):.4f}  "
              f"sd {st.stdev(aucs):.3f}  folds>={TARGET}: {sum(1 for a in aucs if a >= TARGET):>2}/{len(aucs)}"
              f"  {'** CLEARS **' if med >= TARGET else ''}")

    best = max(results, key=lambda r: r["medianAuc"])
    sanity = next(r for r in results if r["label"] == "logistic-base")

    print(f"\n{'=' * 74}")
    print(f"  sanity   logistic-base {sanity['medianAuc']:.4f} vs Gate 0's {INCUMBENT} "
          f"({'OK' if abs(sanity['medianAuc'] - INCUMBENT) < 0.03 else 'MISMATCH — investigate before trusting anything'})")
    print(f"  best     {best['label']}  median AUC {best['medianAuc']:.4f}")
    print(f"  target   {TARGET}")
    print(f"{'=' * 74}")

    cleared = best["medianAuc"] >= TARGET
    if cleared:
        print(f"\n  '{best['label']}' CLEARS the {TARGET} bar.")
        print("  NEXT STEP IS MANDATORY: re-validate on the untouched held-out")
        print("  universe (AVAXUSDT/DOTUSDT/INJUSDT) before drawing any conclusion.")
        print("  Nothing here authorises capital — this is an AUC result, not expectancy.")
    else:
        print(f"\n  NO CANDIDATE REACHES {TARGET}. Best is {best['medianAuc']:.4f}"
              f" ({best['label']}), a {best['medianAuc'] - INCUMBENT:+.4f} change on the incumbent.")
        print("  Per §5.12.3 this is the stop signal: if free data cannot reach the")
        print("  bar, tick-data infrastructure is not justified either — it is a much")
        print("  larger bet on the same hypothesis that just failed cheaply.")
        print("  The held-out universe is deliberately NOT spent: there is nothing to")
        print("  validate, and it stays clean for any future attempt.")

    out = os.path.join(REPO, "data/validation/auc-feasibility-2026-09-08.json")
    with open(out, "w") as f:
        json.dump({
            "kind": "auc-feasibility",
            "question": f"Can any model on free data reach out-of-sample AUC >= {TARGET}?",
            "target": TARGET, "incumbent": INCUMBENT,
            "labelFixed": {"tp": manifest["tp"], "sl": manifest["sl"], "horizon": manifest["horizon"]},
            "symbols": manifest["symbols"],
            "heldOutUniverseTouched": False,
            "candidatesEvaluated": len(CANDIDATES), "cap": 10,
            "candidates": results, "best": best["label"], "cleared": cleared,
        }, f, indent=2)
    print(f"\n  wrote {out}")
    return 0 if cleared else 1


if __name__ == "__main__":
    sys.exit(main())
