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
  };
  const result = await recommendSymbols(restClient, 50, 25);
  assert.deepEqual(result, []);
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