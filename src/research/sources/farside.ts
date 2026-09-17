// farside-btc-etf / farside-eth-etf adapters — specs/daily-catalyst-manual-trading.md §5.3b, §10.2.
//
// Farside publishes daily per-fund US spot ETF flows as a hand-styled HTML table; there is no
// official API (X10). We hand-parse the "Total" column (no HTML-parsing dependency) and
// validate the header still contains "Total" before trusting any row — AC-6 requires a
// changed header to come back `invalid` with zero rows, never a partial read.
//
// Farside may block non-browser clients. If the HTML fetch is unavailable, we fall back to a
// manual CSV the owner can drop at data/manual/farside-<btc|eth>.csv:
//
//   date,totalUsdMillions
//   2026-09-15,123.4
//   2026-09-16,-45.0
//
// (header row required; values are US$ millions, same unit as the site). Its `availableAt` is
// the file's mtime, since a human dropped it in at that moment.

import type { AdapterDeps } from "../http.ts";
import { fetchWithRetryPolicy } from "../http.ts";
import type { SourceAdapter, SourceId, SourceRow } from "../types.ts";
import { okSnapshot, invalidSnapshot, unavailableSnapshot } from "./common.ts";

const USD_MILLIONS_TO_USD = 1_000_000;
// An honest user agent. Farside's bot protection answers 403 to scripts; this project does not try to look
// like a browser to get around that. The owner saves the pages in a real browser and imports them with
// `npm run farside:import` into the CSV fallback read below.
const FARSIDE_USER_AGENT = "crypto-trader-research/0.2 (personal research; manual CSV import fallback)";

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function parseCellNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const negMatch = /^\((.+)\)$/.exec(cleaned);
  const n = Number(negMatch ? negMatch[1] : cleaned);
  if (!Number.isFinite(n)) return null;
  return negMatch ? -n : n;
}

export type FarsideParseResult = { kind: "ok"; rows: SourceRow[] } | { kind: "invalid"; detail: string };

/** Hand-written parser for Farside's "etf" flow table. Exported for tests. */
export function parseFarsideHtml(html: string, currencyKey: "BTC" | "ETH", fetchedAt: number): FarsideParseResult {
  const tableMatch = /<table[^>]*class="etf"[^>]*>([\s\S]*?)<\/table>/.exec(html);
  if (!tableMatch) {
    return { kind: "invalid", detail: 'no <table class="etf"> found in Farside page' };
  }
  const table = tableMatch[1]!;

  const theadMatch = /<thead>([\s\S]*?)<\/thead>/.exec(table);
  if (!theadMatch) {
    return { kind: "invalid", detail: "no <thead> found in Farside table" };
  }
  const headers = [...theadMatch[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => stripTags(m[1]!));
  const totalIndex = headers.findIndex((h) => h === "Total");
  if (totalIndex === -1) {
    return { kind: "invalid", detail: `Farside header changed — no "Total" column found (headers: ${headers.join(", ")})` };
  }

  const bodyHtml = table.slice((theadMatch.index ?? 0) + theadMatch[0].length);
  const rows: SourceRow[] = [];
  for (const trMatch of bodyHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...trMatch[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]!));
    if (cells.length === 0) continue;
    const dateMatch = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/.exec(cells[0]!);
    if (!dateMatch) continue; // not a data row (e.g. the trailing "Total" summary row)
    const day = Number(dateMatch[1]);
    const month = MONTHS[dateMatch[2]!]!;
    const year = Number(dateMatch[3]);
    const observedFor = Date.UTC(year, month, day);

    const totalCell = cells[totalIndex];
    if (totalCell === undefined) continue;
    const value = parseCellNumber(totalCell);
    if (value === null) continue; // "-" — no data yet for that day

    rows.push({ key: currencyKey, observedFor, availableAt: fetchedAt, field: "netFlowUsd", value: value * USD_MILLIONS_TO_USD });
  }

  return { kind: "ok", rows };
}

/** Parses the manual CSV fallback: header `date,totalUsdMillions`, then `YYYY-MM-DD,<number>` rows. */
export function parseFarsideCsv(text: string, currencyKey: "BTC" | "ETH", availableAt: number): SourceRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("empty CSV file");
  const header = lines[0]!.split(",").map((s) => s.trim());
  if (header[0] !== "date" || header[1] !== "totalUsdMillions") {
    throw new Error(`unexpected CSV header "${lines[0]}" — expected "date,totalUsdMillions"`);
  }
  const rows: SourceRow[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    const dateStr = parts[0]?.trim();
    const valueStr = parts[1]?.trim();
    const observedFor = dateStr ? Date.parse(`${dateStr}T00:00:00Z`) : Number.NaN;
    const value = Number(valueStr);
    if (!dateStr || !Number.isFinite(observedFor) || !Number.isFinite(value)) {
      throw new Error(`unparseable CSV row "${line}"`);
    }
    rows.push({ key: currencyKey, observedFor, availableAt, field: "netFlowUsd", value: value * USD_MILLIONS_TO_USD });
  }
  return rows;
}

interface FarsideAdapterOpts {
  id: SourceId;
  url: string;
  currencyKey: "BTC" | "ETH";
  csvPath: string;
}

function createFarsideAdapter(opts: FarsideAdapterOpts, deps: AdapterDeps): SourceAdapter {
  return {
    id: opts.id,
    maxStalenessMs: 4 * 24 * 60 * 60 * 1000,
    async fetch() {
      const fetchedAt = deps.now();
      const http = await fetchWithRetryPolicy(opts.url, { headers: { "User-Agent": FARSIDE_USER_AGENT } }, deps);

      if (http.kind === "ok" && http.status === 200) {
        const parsed = parseFarsideHtml(http.body, opts.currencyKey, fetchedAt);
        if (parsed.kind === "invalid") return invalidSnapshot(opts.id, fetchedAt, parsed.detail);
        return okSnapshot(opts.id, fetchedAt, parsed.rows);
      }

      const htmlFailureDetail = http.kind === "unavailable" ? http.detail : `Farside returned HTTP ${http.status}`;
      if (!deps.fileExists(opts.csvPath)) {
        return unavailableSnapshot(opts.id, fetchedAt, `${htmlFailureDetail}; no manual fallback at ${opts.csvPath}`);
      }
      try {
        const rows = parseFarsideCsv(deps.readFile(opts.csvPath), opts.currencyKey, deps.statMtimeMs(opts.csvPath));
        return okSnapshot(opts.id, fetchedAt, rows);
      } catch (err) {
        return invalidSnapshot(opts.id, fetchedAt, `${htmlFailureDetail}; manual fallback ${opts.csvPath} is malformed: ${(err as Error).message}`);
      }
    },
  };
}

export const FARSIDE_BTC_CSV_PATH = "data/manual/farside-btc.csv";
export const FARSIDE_ETH_CSV_PATH = "data/manual/farside-eth.csv";

export function createFarsideBtcAdapter(deps: AdapterDeps): SourceAdapter {
  return createFarsideAdapter(
    { id: "farside-btc-etf", url: "https://farside.co.uk/bitcoin-etf-flow-all-data/", currencyKey: "BTC", csvPath: FARSIDE_BTC_CSV_PATH },
    deps,
  );
}

export function createFarsideEthAdapter(deps: AdapterDeps): SourceAdapter {
  return createFarsideAdapter(
    { id: "farside-eth-etf", url: "https://farside.co.uk/ethereum-etf-flow-all-data/", currencyKey: "ETH", csvPath: FARSIDE_ETH_CSV_PATH },
    deps,
  );
}
