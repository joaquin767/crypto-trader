// Shared types for the daily-catalyst research pipeline (Phase 1 — data foundation).
// See specs/daily-catalyst-manual-trading.md §5.1 for the normative contract; types here
// are verbatim from that section unless noted.

export type SourceId =
  | "bybit-klines-1d" | "bybit-klines-1h" | "bybit-funding" | "bybit-oi"
  | "coinalyze-oi" | "farside-btc-etf" | "farside-eth-etf" | "fred-release-dates"
  | "macro-calendar-manual" | "defillama-stablecoins" | "fear-greed" | "unlocks-manual";

export type SourceStatus = "ok" | "stale" | "unavailable" | "invalid";

export interface SourceRow {
  key: string;            // e.g. "BTC/USDT" or "USDT" or "CPI"
  observedFor: number;    // the period the value describes (start of UTC day, or event time)
  availableAt: number;    // earliest time this value could have been known
  value: number | string;
  field: string;          // e.g. "fundingRate", "netFlowUsd", "eventType"
}

export interface SourceSnapshot {
  sourceId: SourceId;
  fetchedAt: number;
  status: SourceStatus;
  statusDetail: string;   // non-empty whenever status !== "ok"
  rows: SourceRow[];
  sha256: string;         // of JSON.stringify(rows)
}

export interface SourceAdapter {
  id: SourceId;
  maxStalenessMs: number;
  /** Rejects never: network/parse failures are returned as status "unavailable"/"invalid". */
  fetch(decisionTime: number, symbols: readonly string[]): Promise<SourceSnapshot>;
}

export type FeatureName =
  | "close" | "return1d" | "return7d" | "atr14d" | "realizedVol7d"
  | "fundingRate8hAvg3d" | "fundingRatePercentile90d" | "oiChange3dPct"
  | "btcEtfNetFlowUsd1d" | "btcEtfNetFlowUsd5d" | "ethEtfNetFlowUsd1d"
  | "stablecoinSupplyChange7dPct" | "fearGreed"
  | "hoursToNextFomc" | "hoursToNextCpi" | "daysToNextUnlock" | "nextUnlockPctOfFloat";

export type FeatureValue =
  | { kind: "value"; value: number; availableAt: number; sourceId: SourceId }
  | { kind: "missing"; reason: string; sourceId: SourceId };

export type FeatureVector = { symbol: string; decisionTime: number; features: Record<FeatureName, FeatureValue> };

/** OHLCV bar; t = bar open time. New type (the 5m engine has no shared exported kline type). */
export interface Kline { t: number; o: number; h: number; l: number; c: number; v: number; }

// ── §5.3b manual input files (committed, owner-maintained) ────────────────────────────

/** data/manual/macro-calendar.json */
export interface MacroCalendarFile {
  asOf: string; // YYYY-MM-DD
  events: { type: "FOMC"; time: string /* ISO-8601 UTC */ }[];
}

/** data/manual/unlocks.json */
export interface UnlocksFile {
  asOf: string;
  unlocks: { asset: string /* e.g. "APT" */; time: string; pctOfCirculating: number }[];
}
