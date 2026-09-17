// farside:import — turn Farside ETF flow pages saved from a browser into the owner-maintained CSV fallback
// (data/manual/farside-<btc|eth>.csv) read by the Farside source adapter and by `npm run backfill`.
//
// Farside's bot protection blocks scripted access (HTTP 403), and this project does not work around it. The
// owner opens https://farside.co.uk/bitcoin-etf-flow-all-data/ and .../ethereum-etf-flow-all-data/ in a
// browser, saves each page ("Save Page As… → Webpage, HTML only"), and runs:
//
//   npm run farside:import -- --btc ~/Downloads/btc.html --eth ~/Downloads/eth.html
//
// Parsing reuses parseFarsideHtml, so a changed table header is rejected exactly as in the live adapter.
// Rows are merged with any existing CSV by date; values from the new import win for dates present in both
// (Farside can revise recent days). Both files are written only if both pages parse — never one of two.
// At least one of --btc / --eth is required.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseFarsideCsv, parseFarsideHtml } from "../src/research/sources/farside.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Newest flow date older than this (vs now) triggers a warning: the saved page is probably stale. */
export const STALE_WARNING_DAYS = 4;

export interface FarsideImportSummary {
  asset: "BTC" | "ETH";
  rows: number;
  firstDate: string;
  lastDate: string;
  added: number;
  changed: number;
  warnings: string[];
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Pure. Parses the saved page, merges with the existing CSV text (if any) and returns the new CSV text.
 *  Throws with a readable message when the page doesn't contain a valid Farside flow table. */
export function buildFarsideCsv(html: string, asset: "BTC" | "ETH", existingCsv: string | null, now: number):
  { csv: string; summary: FarsideImportSummary } {
  const parsed = parseFarsideHtml(html, asset, now);
  if (parsed.kind === "invalid") throw new Error(`${asset}: ${parsed.detail}`);
  if (parsed.rows.length === 0) throw new Error(`${asset}: the saved page has a flow table but no dated rows with values`);

  const byDate = new Map<string, number>();
  if (existingCsv !== null && existingCsv.trim().length > 0) {
    for (const row of parseFarsideCsv(existingCsv, asset, 0)) byDate.set(isoDate(row.observedFor), Number(row.value) / 1_000_000);
  }

  let added = 0;
  let changed = 0;
  for (const row of parsed.rows) {
    const date = isoDate(row.observedFor);
    // Farside shows one decimal in US$ millions; rounding removes float noise from the USD conversion.
    const millions = Math.round((Number(row.value) / 1_000_000) * 10_000) / 10_000;
    const previous = byDate.get(date);
    if (previous === undefined) added++;
    else if (Math.abs(previous - millions) > 1e-9) changed++;
    byDate.set(date, millions);
  }

  const dates = [...byDate.keys()].sort();
  const lines = ["date,totalUsdMillions", ...dates.map((d) => `${d},${byDate.get(d)}`)];
  const lastDate = dates.at(-1)!;
  const warnings: string[] = [];
  const ageDays = Math.floor((now - Date.parse(`${lastDate}T00:00:00Z`)) / DAY_MS);
  if (ageDays > STALE_WARNING_DAYS) {
    warnings.push(`${asset}: newest flow date is ${lastDate} (${ageDays} days old) — was the page saved today?`);
  }
  return {
    csv: `${lines.join("\n")}\n`,
    summary: { asset, rows: dates.length, firstDate: dates[0]!, lastDate, added, changed, warnings },
  };
}

export interface FarsideImportArgs { btc: string | null; eth: string | null; outDir: string }

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseFarsideImportArgs(argv: readonly string[]): FarsideImportArgs {
  const args = { btc: flagValue(argv, "--btc") ?? null, eth: flagValue(argv, "--eth") ?? null, outDir: flagValue(argv, "--out-dir") ?? "data/manual" };
  if (args.btc === null && args.eth === null) {
    throw new Error("usage: farside-import.ts --btc <saved-btc-page.html> --eth <saved-eth-page.html> [--out-dir data/manual]");
  }
  return args;
}

/** Builds every requested CSV first; writes them (atomically, temp + rename) only if all succeeded. */
export function runFarsideImport(args: FarsideImportArgs, now: number): { exitCode: number; lines: string[] } {
  const jobs = ([["BTC", args.btc], ["ETH", args.eth]] as const).filter(([, path]) => path !== null);
  const built: { outPath: string; csv: string; summary: FarsideImportSummary }[] = [];
  try {
    for (const [asset, htmlPath] of jobs) {
      if (!existsSync(htmlPath!)) throw new Error(`${asset}: saved page not found at ${htmlPath}`);
      const outPath = join(args.outDir, `farside-${asset.toLowerCase()}.csv`);
      const existing = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;
      const { csv, summary } = buildFarsideCsv(readFileSync(htmlPath!, "utf-8"), asset, existing, now);
      built.push({ outPath, csv, summary });
    }
  } catch (err) {
    return { exitCode: 1, lines: [`farside:import failed, nothing written — ${(err as Error).message}`] };
  }

  const lines: string[] = [];
  for (const { outPath, csv, summary } of built) {
    const tmp = `${outPath}.tmp`;
    writeFileSync(tmp, csv);
    renameSync(tmp, outPath);
    lines.push(`${summary.asset}: ${outPath} — ${summary.rows} days (${summary.firstDate} → ${summary.lastDate}), ${summary.added} added, ${summary.changed} changed`);
    lines.push(...summary.warnings);
  }
  return { exitCode: 0, lines };
}

async function main(): Promise<void> {
  let args: FarsideImportArgs;
  try {
    args = parseFarsideImportArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const result = runFarsideImport(args, Date.now());
  for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
  process.exitCode = result.exitCode;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
