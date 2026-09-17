// farside:import tests — browser-saved Farside pages → data/manual/farside-<btc|eth>.csv.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildFarsideCsv, parseFarsideImportArgs, runFarsideImport } from "../scripts/farside-import.ts";
import { parseFarsideCsv } from "../src/research/sources/farside.ts";

const VALID_HTML = readFileSync("tests/fixtures/research/farside-btc-valid.html", "utf-8");
const BAD_HEADER_HTML = readFileSync("tests/fixtures/research/farside-btc-bad-header.html", "utf-8");
const NOW = Date.parse("2024-01-13T12:00:00Z");

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "farside-import-test-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a saved all-data page becomes a CSV the adapter's own CSV parser accepts, in US$ millions", () => {
  const { csv, summary } = buildFarsideCsv(VALID_HTML, "BTC", null, NOW);
  assert.equal(csv, "date,totalUsdMillions\n2024-01-11,655.3\n2024-01-12,-171.5\n");
  assert.deepEqual({ rows: summary.rows, first: summary.firstDate, last: summary.lastDate, added: summary.added, changed: summary.changed },
    { rows: 2, first: "2024-01-11", last: "2024-01-12", added: 2, changed: 0 });
  const rows = parseFarsideCsv(csv, "BTC", 0);
  assert.deepEqual(rows.map((r) => r.value), [655_300_000, -171_500_000]);
});

test("merging keeps older dates, adds new ones, and lets the new import win on revised values", () => {
  const existing = "date,totalUsdMillions\n2024-01-10,12.5\n2024-01-11,600\n";
  const { csv, summary } = buildFarsideCsv(VALID_HTML, "BTC", existing, NOW);
  assert.equal(csv, "date,totalUsdMillions\n2024-01-10,12.5\n2024-01-11,655.3\n2024-01-12,-171.5\n");
  assert.equal(summary.added, 1);
  assert.equal(summary.changed, 1);
});

test("a page whose table header changed is rejected with the adapter's reason", () => {
  assert.throws(() => buildFarsideCsv(BAD_HEADER_HTML, "BTC", null, NOW), /Total/);
});

test("a page with no Farside flow table is rejected", () => {
  assert.throws(() => buildFarsideCsv("<html><body>Just a moment...</body></html>", "ETH", null, NOW), /ETH/);
});

test("an old saved page produces a staleness warning", () => {
  const { summary } = buildFarsideCsv(VALID_HTML, "BTC", null, Date.parse("2024-02-01T00:00:00Z"));
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0]!, /2024-01-12/);
});

test("runFarsideImport writes nothing when any requested page is invalid (both-or-nothing)", () => {
  withTempDir((dir) => {
    const btc = join(dir, "btc.html");
    const eth = join(dir, "eth.html");
    writeFileSync(btc, VALID_HTML);
    writeFileSync(eth, BAD_HEADER_HTML);
    const result = runFarsideImport({ btc, eth, outDir: dir }, NOW);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines[0]!, /nothing written/);
    assert.equal(existsSync(join(dir, "farside-btc.csv")), false);
    assert.equal(existsSync(join(dir, "farside-eth.csv")), false);
  });
});

test("runFarsideImport writes the CSV and reports the date range; a missing file fails cleanly", () => {
  withTempDir((dir) => {
    const btc = join(dir, "btc.html");
    writeFileSync(btc, VALID_HTML);
    const ok = runFarsideImport({ btc, eth: null, outDir: dir }, NOW);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.lines[0]!, /2 days \(2024-01-11 → 2024-01-12\)/);
    assert.equal(readFileSync(join(dir, "farside-btc.csv"), "utf-8").split("\n")[0], "date,totalUsdMillions");
    assert.equal(existsSync(join(dir, "farside-btc.csv.tmp")), false);

    const missing = runFarsideImport({ btc: join(dir, "nope.html"), eth: null, outDir: dir }, NOW);
    assert.equal(missing.exitCode, 1);
  });
});

test("parseFarsideImportArgs requires at least one page", () => {
  assert.throws(() => parseFarsideImportArgs([]), /usage/);
  assert.deepEqual(parseFarsideImportArgs(["--eth", "e.html"]), { btc: null, eth: "e.html", outDir: "data/manual" });
});
