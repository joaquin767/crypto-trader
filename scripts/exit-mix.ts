// Exit-mix measurement — the reproducible artifact behind the TP/SL/horizon
// split quoted in specs/profit-target-roadmap.md F2.
//
// Answers one question: when a long entry is opened at a bar's close with the
// configured barriers, which barrier does it actually hit, and how long does
// it take? Replays the SAME triple-barrier walk-forward that
// scripts/train-model.ts uses to LABEL training data (:79 labelTripleBarrier),
// but records which barrier ended each path instead of collapsing it to 1/0.
//
// Bars are rebuilt as dollar bars using the ratio the live model was trained
// with, so the horizon here means the same thing it means in production.
//
// This measures the barrier geometry over EVERY bar, not over the subset the
// model gate would actually enter on — so it is the unconditional exit mix,
// which is why its sample count is far larger than a backtest's trade count.
//
// Usage:
//   node --experimental-strip-types scripts/exit-mix.ts --data data/klines --held-out 0.25

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { toDollarBars, suggestDollarThreshold } from "../src/strategy/bars.ts";
import { loadModel, DEFAULT_MODEL_PATH } from "../src/strategy/model.ts";
import type { Candle } from "../src/strategy/backtest.ts";

interface Args { dataDir: string; heldOut: number; tp: number; sl: number; horizon: number; out: string }

function parseArgs(argv: string[]): Args {
  const get = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
  const model = loadModel(DEFAULT_MODEL_PATH);
  return {
    dataDir: get("--data", "data/klines"),
    heldOut: Number.parseFloat(get("--held-out", "0.25")),
    // Default to whatever the live model was actually trained with, so this
    // measurement describes the deployed configuration rather than a guess.
    tp: Number.parseFloat(get("--tp", String(model?.trainedOn.takeProfitPercent ?? 1.5))),
    sl: Number.parseFloat(get("--sl", String(model?.trainedOn.stopLossPercent ?? 1.5))),
    horizon: Number.parseInt(get("--horizon", String(model?.trainedOn.horizonBars ?? 7)), 10),
    out: get("--out", `data/validation/exit-mix-${new Date().toISOString().slice(0, 10)}.json`),
  };
}

type Outcome = "take_profit" | "stop_loss" | "horizon";

/** Walk forward from bar i until a barrier is touched. Returns null when
 *  fewer than `horizon` bars remain (an unresolved path is excluded, never
 *  counted as a timeout — that would inflate the horizon bucket with pure
 *  end-of-data artifacts). */
function resolveBarrier(
  bars: Candle[], i: number, tpPct: number, slPct: number, horizon: number,
): { outcome: Outcome; bars: number; ms: number } | null {
  if (i + horizon >= bars.length) return null;
  const entry = bars[i]!.close;
  const tp = entry * (1 + tpPct / 100);
  const sl = entry * (1 - slPct / 100);
  for (let k = i + 1; k <= i + horizon; k++) {
    const b = bars[k]!;
    // Conservative tie-break: if a single bar's range spans BOTH barriers,
    // count the stop. OHLC cannot say which was touched first, and assuming
    // the profitable one is exactly the optimism this project has had to
    // correct five times already.
    if (b.low <= sl) return { outcome: "stop_loss", bars: k - i, ms: b.openTime - bars[i]!.openTime };
    if (b.high >= tp) return { outcome: "take_profit", bars: k - i, ms: b.openTime - bars[i]!.openTime };
  }
  const last = bars[i + horizon]!;
  return { outcome: "horizon", bars: horizon, ms: last.openTime - bars[i]!.openTime };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const model = loadModel(DEFAULT_MODEL_PATH);
  const ratio = model?.trainedOn.timeBarsPerDollarBar ?? 0;

  const counts: Record<Outcome, number> = { take_profit: 0, stop_loss: 0, horizon: 0 };
  const holdsMs: number[] = [];
  const perSymbol: Record<string, { samples: number } & Record<Outcome, number>> = {};

  const files = readdirSync(a.dataDir).filter(f => f.endsWith(".json")).sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${a.dataDir}/${file}`, "utf-8")) as { symbol: string; candles: Candle[] };
    const cut = Math.floor(raw.candles.length * (1 - a.heldOut));
    const timeBars = raw.candles.slice(cut);

    // Rebuild bars the way the model was trained. Each symbol derives its own
    // threshold to hit the same compression, exactly as model.ts does live —
    // a single shared dollar threshold starves low-volume symbols.
    const bars = ratio > 1
      ? toDollarBars(timeBars, suggestDollarThreshold(timeBars, Math.floor(timeBars.length / ratio)))
      : timeBars;

    perSymbol[raw.symbol] = { samples: 0, take_profit: 0, stop_loss: 0, horizon: 0 };
    for (let i = 0; i < bars.length; i++) {
      const r = resolveBarrier(bars, i, a.tp, a.sl, a.horizon);
      if (!r) continue;
      counts[r.outcome]++;
      holdsMs.push(r.ms);
      perSymbol[raw.symbol]!.samples++;
      perSymbol[raw.symbol]![r.outcome]++;
    }
    const p = perSymbol[raw.symbol]!;
    console.log(`  ${raw.symbol.padEnd(10)} ${String(p.samples).padStart(5)} paths  ` +
      `TP ${((p.take_profit / p.samples) * 100).toFixed(1)}%  ` +
      `SL ${((p.stop_loss / p.samples) * 100).toFixed(1)}%  ` +
      `horizon ${((p.horizon / p.samples) * 100).toFixed(1)}%`);
  }

  const total = counts.take_profit + counts.stop_loss + counts.horizon;
  if (total === 0) throw new Error("No resolvable barrier paths — check --data and --held-out.");

  const share = (n: number) => n / total;
  const mins = holdsMs.map(m => m / 60_000);

  console.log(`\n  TOTAL ${total} paths  TP ${(share(counts.take_profit) * 100).toFixed(1)}%  ` +
    `SL ${(share(counts.stop_loss) * 100).toFixed(1)}%  horizon ${(share(counts.horizon) * 100).toFixed(1)}%`);
  console.log(`  hold: median ${median(mins).toFixed(0)} min  p25 ${quantile(mins, 0.25).toFixed(0)}  p75 ${quantile(mins, 0.75).toFixed(0)}`);

  const artifact = {
    generatedAt: new Date().toISOString(),
    kind: "exit-mix",
    caveat:
      "UNCONDITIONAL exit mix: every bar is treated as a hypothetical entry, not only the bars " +
      "the model gate would enter on. Sample count is therefore much larger than a backtest's " +
      "trade count, and the mix a gated strategy realises may differ. Ties (a bar spanning both " +
      "barriers) are resolved as stop_loss.",
    command: `node --experimental-strip-types scripts/exit-mix.ts --data ${a.dataDir} --held-out ${a.heldOut} --tp ${a.tp} --sl ${a.sl} --horizon ${a.horizon}`,
    barriers: { takeProfitPercent: a.tp, stopLossPercent: a.sl, horizonBars: a.horizon },
    bars: ratio > 1 ? { kind: "dollar", timeBarsPerDollarBar: ratio } : { kind: "time", interval: "5m" },
    heldOutFraction: a.heldOut,
    totals: {
      samples: total,
      takeProfit: counts.take_profit, stopLoss: counts.stop_loss, horizon: counts.horizon,
      takeProfitShare: share(counts.take_profit),
      stopLossShare: share(counts.stop_loss),
      horizonShare: share(counts.horizon),
      holdMinutes: { median: median(mins), p25: quantile(mins, 0.25), p75: quantile(mins, 0.75) },
    },
    perSymbol,
  };

  mkdirSync(a.out.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(a.out, JSON.stringify(artifact, null, 2));
  console.log(`\n  wrote ${a.out}`);
}

await main();
