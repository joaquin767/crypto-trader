import { test } from "node:test";
import assert from "node:assert/strict";

// Unit tests for the symbol recommender logic (pure functions)

// We test the scoring logic directly by recreating the algorithm here
function calculateScore(
  maxCapitalUsd: number,
  maxPositionSizeUsd: number,
  minTradeCost: number,
  volume24h: number,
): number {
  const affordability = maxCapitalUsd / minTradeCost;
  const liquidityFactor = Math.min(volume24h / 1000000, 100);
  const positionFit = maxCapitalUsd / Math.max(maxPositionSizeUsd, minTradeCost);
  return affordability * 10 + liquidityFactor * 0.1 + positionFit * 5;
}

test("high affordability scores better for small capital", () => {
  const scoreCheap = calculateScore(50, 25, 0.5, 10000000); // 50/0.5=100 trades possible
  const scoreExpensive = calculateScore(50, 25, 80, 10000000); // 50/80=0.6 trades possible
  assert(scoreCheap > scoreExpensive, "cheap symbols should score higher");
});

test("higher volume improves score slightly", () => {
  const scoreLowVol = calculateScore(50, 25, 10, 100000);
  const scoreHighVol = calculateScore(50, 25, 10, 100000000);
  assert(scoreHighVol > scoreLowVol, "higher volume should score better");
});

test("cheap symbols with good volume are ideal for small capital", () => {
  // DOGE-like: $0.10, minQty 1 = $0.10 min trade, high volume
  const score = calculateScore(50, 25, 0.1, 50000000);
  assert(score > 500, "cheap liquid symbols should have high score");
});

test("expensive symbols score poorly for small capital", () => {
  // BTC-like: $80000, minQty 0.001 = $80 min trade
  const score = calculateScore(50, 25, 80, 500000000);
  assert(score < 100, "expensive symbols should have low score for small capital");
});

test("recommendSymbols returns empty when instruments list is empty", async () => {
  const { recommendSymbols } = await import("../src/strategy/symbol-recommender.ts");
  const restClient = {
    getInstruments: async () => ({ category: "linear", list: [] }),
    getTickers: async () => ({ category: "linear", list: [] }),
    getOrderbook: async () => ({ bids: [], asks: [], timestamp: Date.now() }),
  };
  const result = await recommendSymbols(restClient, 50, 25);
  assert.deepEqual(result, []);
});

// Regression coverage for a real event: GRT/USDT scored "Excellent for small
// capital" on affordability alone (cheap price, tiny minQty) and got
// auto-selected, then three separate market buys were cancelled outright by
// Bybit (IOC, "EC_NoImmediateQtyToFill") because the book was actually empty
// at trade time — 24h volume said nothing about liquidity *right now*.

function makeInstrument(symbol: string, minQty = "1", qtyStep = "1") {
  return {
    symbol, contractType: "LinearPerpetual",
    lotSizeFilter: { minOrderQty: minQty, qtyStep },
    priceFilter: { tickSize: "0.01" },
  };
}

test("recommendSymbols excludes a high-scoring symbol whose order book has no real depth", async () => {
  const { recommendSymbols } = await import("../src/strategy/symbol-recommender.ts");
  const restClient = {
    getInstruments: async () => ({
      category: "linear",
      list: [makeInstrument("GRTUSDT"), makeInstrument("SOLUSDT", "0.1", "0.1")],
    }),
    getTickers: async () => ({
      category: "linear",
      list: [
        { symbol: "GRTUSDT", lastPrice: "0.02", volume24h: "50000000" }, // looks great on paper
        { symbol: "SOLUSDT", lastPrice: "100", volume24h: "10000000" },
      ],
    }),
    getOrderbook: async (_category: string, symbol: string) => {
      if (symbol === "GRTUSDT") return { bids: [] as [string, string][], asks: [] as [string, string][], timestamp: Date.now() }; // empty book
      return { bids: [["99", "10"]] as [string, string][], asks: [["100", "10"]] as [string, string][], timestamp: Date.now() }; // $1000 of depth
    },
  };
  const result = await recommendSymbols(restClient, 50, 25, 5);
  assert(!result.some(r => r.symbol === "GRT/USDT"), "GRT/USDT must be excluded despite scoring well on affordability alone");
  assert(result.some(r => r.symbol === "SOL/USDT"), "SOL/USDT has real depth and should still be recommended");
});

test("recommendSymbols excludes a symbol whose ask-side depth is real but insufficient", async () => {
  const { recommendSymbols } = await import("../src/strategy/symbol-recommender.ts");
  const restClient = {
    getInstruments: async () => ({ category: "linear", list: [makeInstrument("GRTUSDT")] }),
    getTickers: async () => ({ category: "linear", list: [{ symbol: "GRTUSDT", lastPrice: "0.02", volume24h: "50000000" }] }),
    // Only $2 of ask depth — far short of maxPositionSizeUsd (25).
    getOrderbook: async () => ({ bids: [] as [string, string][], asks: [["0.02", "100"]] as [string, string][], timestamp: Date.now() }),
  };
  const result = await recommendSymbols(restClient, 50, 25, 5);
  assert.equal(result.length, 0);
});

test("recommendSymbols keeps a symbol whose depth is spread across multiple book levels", async () => {
  const { recommendSymbols } = await import("../src/strategy/symbol-recommender.ts");
  const restClient = {
    getInstruments: async () => ({ category: "linear", list: [makeInstrument("GRTUSDT")] }),
    getTickers: async () => ({ category: "linear", list: [{ symbol: "GRTUSDT", lastPrice: "0.02", volume24h: "50000000" }] }),
    // No single level covers maxPositionSizeUsd (25), but cumulatively they do.
    getOrderbook: async () => ({
      bids: [] as [string, string][],
      asks: [["0.02", "500"], ["0.021", "500"], ["0.022", "500"]] as [string, string][], // ~$10, $10.5, $11 = ~$31.5 cumulative
      timestamp: Date.now(),
    }),
  };
  const result = await recommendSymbols(restClient, 50, 25, 5);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.symbol, "GRT/USDT");
});

test("recommendSymbols excludes a symbol when the orderbook check itself fails (fail closed)", async () => {
  const { recommendSymbols } = await import("../src/strategy/symbol-recommender.ts");
  const restClient = {
    getInstruments: async () => ({ category: "linear", list: [makeInstrument("GRTUSDT")] }),
    getTickers: async () => ({ category: "linear", list: [{ symbol: "GRTUSDT", lastPrice: "0.02", volume24h: "50000000" }] }),
    getOrderbook: async () => { throw new Error("network error"); },
  };
  const result = await recommendSymbols(restClient, 50, 25, 5);
  assert.equal(result.length, 0, "an unverifiable symbol must be excluded, not assumed liquid");
});

test("checkConfiguredSymbols returns result for each symbol", async () => {
  const { checkConfiguredSymbols } = await import("../src/strategy/symbol-recommender.ts");
  const restClient = {
    getTickers: async (category: string, symbol?: string) => ({
      category: "linear",
      list: symbol === "BTCUSDT"
        ? [{ symbol: "BTCUSDT", lastPrice: "80000", volume24h: "100000" }]
        : symbol === "SOLUSDT"
          ? [{ symbol: "SOLUSDT", lastPrice: "100", volume24h: "1000000" }]
          : [],
    }),
  };
  const results = await checkConfiguredSymbols(restClient, ["BTC/USDT", "SOL/USDT"], 50);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.symbol, "BTC/USDT");
  assert.equal(results[1]!.symbol, "SOL/USDT");
});

test("checkConfiguredSymbols marks expensive symbols as unaffordable", async () => {
  const { checkConfiguredSymbols } = await import("../src/strategy/symbol-recommender.ts");
  const restClient = {
    getTickers: async () => ({
      category: "linear",
      list: [{ symbol: "BTCUSDT", lastPrice: "80000", volume24h: "100000" }],
    }),
  };
  const results = await checkConfiguredSymbols(restClient, ["BTC/USDT"], 50);
  assert.equal(results[0]!.affordable, false);
  assert(results[0]!.minTradeCost > 0);
});