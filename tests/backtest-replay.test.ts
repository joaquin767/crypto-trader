// replayRule tests — specs/daily-catalyst-manual-trading.md §5.10a "Replay loop",
// AC-83, AC-84.

import { test } from "node:test";
import assert from "node:assert/strict";

import { replayRule } from "../src/backtest-daily/replay.ts";
import type { HistoryFile } from "../src/backtest-daily/history-store.ts";
import type { RuleDefinition } from "../src/research/rules.ts";
import type { PlannerConfig } from "../src/research/planner.ts";
import type { SourceRow } from "../src/research/types.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "test-rule", version: 1, description: "d", evidence: ["X1"], status: "experimental",
    symbols: ["BTC/USDT"], side: "long",
    entryWhenAll: [{ feature: "close", op: ">", value: 0 }], invalidateWhenAny: [],
    stopAtrMultiple: 2, targetRMultiple: 3, maxHoldDays: 5, forwardOnly: false, origin: "rules-file",
    ...overrides,
  };
}

const CFG: PlannerConfig = {
  maxCapitalUsd: 100, riskPerTradePercent: 1, maxLeverage: 5, liveLadderCap: 2,
  marginBudgetPercent: 25, maintenanceMarginRate: 0.005, minLiqToStopRatio: 2.0,
  roundTripFeePercent: 0.11, maxOpenManualTrades: 3,
};

/** Contiguous daily bars, high-low range 1000 around a flat 60000 close, so atr14d settles at
 *  ~1000 for every decision day in [fromDay, toDay]. */
function dailyHistory(fromMs: number, toMs: number): HistoryFile {
  const rows: SourceRow[] = [];
  for (let t = fromMs; t <= toMs; t += DAY) {
    const availableAt = t + DAY;
    rows.push(
      { key: "BTC/USDT", observedFor: t, availableAt, field: "open", value: 60000 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "high", value: 60500 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "low", value: 59500 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "close", value: 60000 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  }
  return { sourceId: "bybit-klines-1d", builtAt: 0, coverage: { from: fromMs, to: toMs }, rows };
}

/** Contiguous flat hourly bars (no stop/target touch) so a held trade only ever exits by time. */
function hourlyHistory(fromMs: number, toMs: number): HistoryFile {
  const rows: SourceRow[] = [];
  for (let t = fromMs; t <= toMs; t += HOUR) {
    const availableAt = t + HOUR;
    rows.push(
      { key: "BTC/USDT", observedFor: t, availableAt, field: "open", value: 60000 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "high", value: 60000 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "low", value: 60000 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "close", value: 60000 },
      { key: "BTC/USDT", observedFor: t, availableAt, field: "volume", value: 1000 },
    );
  }
  return { sourceId: "bybit-klines-1h", builtAt: 0, coverage: { from: fromMs, to: toMs }, rows };
}

function fundingHistory(fromMs: number, toMs: number): HistoryFile {
  const rows: SourceRow[] = [];
  for (let t = fromMs; t <= toMs; t += 8 * HOUR) rows.push({ key: "BTC/USDT", observedFor: t, availableAt: t, field: "fundingRate", value: 0 });
  return { sourceId: "bybit-funding", builtAt: 0, coverage: { from: fromMs, to: toMs }, rows };
}

function instrumentsHistory(): HistoryFile {
  const rows: SourceRow[] = [
    { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "minOrderQty", value: 0.0001 },
    { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "qtyStep", value: 0.0001 },
    { key: "BTC/USDT", observedFor: 0, availableAt: 0, field: "minNotionalValue", value: 5 },
  ];
  return { sourceId: "bybit-instruments", builtAt: 0, coverage: { from: 0, to: 0 }, rows };
}

// ── AC-83 ────────────────────────────────────────────────────────────────────────────────────

test("AC-83: a rule triggering 3 consecutive days while the first sim trade holds 5 days produces 1 trade and 2 'position already open' unfilled", () => {
  const firstDay = Date.UTC(2026, 8, 1);
  const dailyFrom = firstDay - 40 * DAY;
  const hourlyFrom = firstDay;
  const hourlyTo = firstDay + 10 * DAY;

  const history: HistoryFile[] = [
    dailyHistory(dailyFrom, firstDay + 2 * DAY),
    hourlyHistory(hourlyFrom, hourlyTo),
    instrumentsHistory(),
    fundingHistory(firstDay - 8 * DAY, hourlyTo + DAY),
  ];

  const result = replayRule({
    rule: rule(),
    history,
    plannerConfig: CFG,
    firstDecisionDay: "2026-09-01",
    lastDecisionDay: "2026-09-03",
    cutoffMs: hourlyTo,
    slippageBps: 0,
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0]!.exitKind, "time"); // flat price -> never hits stop/target
  const positionAlreadyOpen = result.unfilled.filter((u) => u.reason === "position already open");
  assert.equal(positionAlreadyOpen.length, 2);
  assert.deepEqual(positionAlreadyOpen.map((u) => u.day), ["2026-09-02", "2026-09-03"]);
});

// ── AC-84 ────────────────────────────────────────────────────────────────────────────────────

test("AC-84: replayRule never reads (accesses .value of) a 1h bar beyond cutoffMs — a fake history that throws on access completes the run", () => {
  const firstDay = Date.UTC(2026, 8, 1);
  const dailyFrom = firstDay - 40 * DAY;
  const holdoutStart = firstDay + 2 * DAY; // cutoffMs — well before the 5-day hold completes
  const hourlyTo = firstDay + 10 * DAY;

  // Every SourceRow whose availableAt is beyond the cutoff gets a poisoned "value" getter: the
  // replay/backtest pipeline must exclude it via its (safe) timestamp fields BEFORE ever asking
  // for its value, or this test throws instead of completing.
  function poison(rows: SourceRow[]): SourceRow[] {
    return rows.map((r) => {
      if (r.availableAt <= holdoutStart) return r;
      const safe = { key: r.key, observedFor: r.observedFor, availableAt: r.availableAt, field: r.field };
      Object.defineProperty(safe, "value", {
        enumerable: true,
        get(): never {
          throw new Error(`accessed .value of a row beyond holdoutStart (availableAt=${r.availableAt})`);
        },
      });
      return safe as SourceRow;
    });
  }

  const hourly = hourlyHistory(firstDay, hourlyTo);
  const poisonedHourly: HistoryFile = { ...hourly, rows: poison(hourly.rows) };

  const history: HistoryFile[] = [
    dailyHistory(dailyFrom, firstDay + 2 * DAY),
    poisonedHourly,
    instrumentsHistory(),
    fundingHistory(firstDay - 8 * DAY, hourlyTo + DAY),
  ];

  assert.doesNotThrow(() => {
    const result = replayRule({
      rule: rule(),
      history,
      plannerConfig: CFG,
      firstDecisionDay: "2026-09-01",
      lastDecisionDay: "2026-09-01",
      cutoffMs: holdoutStart,
      slippageBps: 0,
    });
    // The trade needed bars past the cutoff to complete its 5-day hold — it must not have been
    // silently filled using data beyond holdoutStart.
    assert.equal(result.trades.length, 0);
    assert.equal(result.unfilled.length, 1);
    // AC-81 through the real pipeline: the artifact names the cutoff, not a data gap.
    assert.match(result.unfilled[0]!.reason, /^cutoff/);
  });
});
