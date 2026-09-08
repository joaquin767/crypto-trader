// Bulk historical kline fetcher — training-data acquisition for the scalping
// model (src/strategy/model.ts). Paginates Bybit's PUBLIC market-data
// endpoint (no API key, no auth, read-only) backwards from now, writing a
// chronologically-ordered candle file per symbol under data/klines/.
//
// Kept out of src/ deliberately: this is offline tooling, never imported by
// the trading loop. Nothing here places orders or touches the journal.
//
// Usage:
//   node --experimental-strip-types scripts/fetch-klines.ts \
//     --symbols APTUSDT,SOLUSDT,ARBUSDT --interval 5 --days 30

import { writeFileSync, mkdirSync } from "node:fs";
import type { Candle } from "../src/strategy/backtest.ts";

const BYBIT_PUBLIC = "https://api.bybit.com/v5/market/kline";
const MAX_PER_REQUEST = 1000;      // Bybit's documented cap
const REQUEST_SPACING_MS = 120;    // stay well inside public rate limits

interface Args { symbols: string[]; interval: string; days: number; outDir: string }

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    symbols: get("--symbols", "APTUSDT").split(",").map(s => s.trim()).filter(Boolean),
    interval: get("--interval", "5"),
    days: Number.parseFloat(get("--days", "30")),
    outDir: get("--out", "data/klines"),
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** One page of candles, newest-first as Bybit returns them. */
async function fetchPage(symbol: string, interval: string, endMs: number): Promise<Candle[]> {
  const url = `${BYBIT_PUBLIC}?category=linear&symbol=${symbol}&interval=${interval}&end=${endMs}&limit=${MAX_PER_REQUEST}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${symbol}`);
  const body = await res.json() as { retCode: number; retMsg: string; result?: { list?: string[][] } };
  if (body.retCode !== 0) throw new Error(`Bybit retCode ${body.retCode}: ${body.retMsg}`);
  return (body.result?.list ?? []).map(k => ({
    openTime: Number.parseInt(k[0]!, 10),
    open: Number.parseFloat(k[1]!),
    high: Number.parseFloat(k[2]!),
    low: Number.parseFloat(k[3]!),
    close: Number.parseFloat(k[4]!),
    volume: Number.parseFloat(k[5]!),
  }));
}

/**
 * Page backwards from `now` until `days` of history is collected or the
 * exchange stops returning new candles (whichever comes first — a symbol
 * listed recently simply has less history, which is not an error).
 */
async function fetchHistory(symbol: string, interval: string, days: number): Promise<Candle[]> {
  const intervalMs = Number.parseInt(interval, 10) * 60_000;
  const targetCount = Math.ceil((days * 24 * 60 * 60_000) / intervalMs);
  const bySeenTime = new Map<number, Candle>();
  let end = Date.now();

  while (bySeenTime.size < targetCount) {
    const page = await fetchPage(symbol, interval, end);
    if (page.length === 0) break;

    const before = bySeenTime.size;
    for (const c of page) bySeenTime.set(c.openTime, c);
    // No new candles means we've hit the start of available history —
    // stop rather than spinning on the same page forever.
    if (bySeenTime.size === before) break;

    const oldest = Math.min(...page.map(c => c.openTime));
    end = oldest - 1;
    process.stdout.write(`\r  ${symbol}: ${bySeenTime.size}/${targetCount} candles`);
    await sleep(REQUEST_SPACING_MS);
  }

  process.stdout.write("\n");
  return [...bySeenTime.values()].sort((a, b) => a.openTime - b.openTime).slice(-targetCount);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });
  console.log(`Fetching ${args.days}d of ${args.interval}m candles for: ${args.symbols.join(", ")}\n`);

  for (const symbol of args.symbols) {
    const candles = await fetchHistory(symbol, args.interval, args.days);
    if (candles.length === 0) {
      console.warn(`  ${symbol}: no candles returned — skipping`);
      continue;
    }
    const path = `${args.outDir}/${symbol}-${args.interval}m.json`;
    writeFileSync(path, JSON.stringify({
      symbol, interval: args.interval,
      fetchedAt: new Date().toISOString(),
      source: `${BYBIT_PUBLIC} (category=linear)`,
      firstOpenTime: candles[0]!.openTime,
      lastOpenTime: candles[candles.length - 1]!.openTime,
      candles,
    }));
    const spanDays = (candles[candles.length - 1]!.openTime - candles[0]!.openTime) / 86_400_000;
    console.log(`  ${symbol}: ${candles.length} candles spanning ${spanDays.toFixed(1)}d -> ${path}`);
  }
}

await main();
