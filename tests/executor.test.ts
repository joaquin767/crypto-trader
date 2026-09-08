import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.ts";
import type { TradeSignal } from "../src/strategy/signals.ts";
import type { Config } from "../src/config.ts";
import type { Portfolio } from "../src/portfolio.ts";
import type { MarketSnapshot } from "../src/market.ts";

const config: Config = {
  exchange: "binance",
  apiKey: "a",
  apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

const indicators = { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 };

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return { positions: [], totalValueUsd: 1000, cashUsd: 1000, dailyTradeCount: 0, maxCapitalUsd: 1000, ...overrides };
}

function makeSnapshot(symbol: string, price: number): MarketSnapshot {
  return { symbol, price, change24h: 0, volume24h: 0, timestamp: Date.now() };
}

test("execute 'hold' returns a hold result", async () => {
  const signal: TradeSignal = { type: "hold", symbol: "BTC/USDT", confidence: 1, reason: "test", indicators };
  const result = await execute(signal, config, makePortfolio(), makeSnapshot("BTC/USDT", 41398), 0);
  assert.equal(result.side, "hold");
  assert.equal(result.quantity, 0);
});

test("execute 'buy' returns a buy result priced at the real snapshot price for the actual symbol", async () => {
  const signal: TradeSignal = { type: "buy", symbol: "SOL/USDT", confidence: 0.8, reason: "test", indicators };
  const result = await execute(signal, config, makePortfolio(), makeSnapshot("SOL/USDT", 150), 300);
  assert.equal(result.side, "buy");
  assert.equal(result.price, 150);
  assert.equal(result.quantity, 300 / 150);
  assert(result.fee > 0);
});

test("execute 'buy' clamps quantity to available cash when the sized position is unaffordable", async () => {
  const signal: TradeSignal = { type: "buy", symbol: "SOL/USDT", confidence: 0.8, reason: "test", indicators };
  const portfolio = makePortfolio({ cashUsd: 50 });
  const result = await execute(signal, config, portfolio, makeSnapshot("SOL/USDT", 150), 300);
  assert.equal(result.side, "buy");
  const cost = result.quantity * result.price + result.fee;
  assert(cost <= 50);
});

test("execute 'sell' uses the actual held quantity, never a hardcoded guess", async () => {
  const signal: TradeSignal = { type: "sell", symbol: "SOL/USDT", confidence: 0.9, reason: "test", indicators };
  const portfolio = makePortfolio({ positions: [{ symbol: "SOL/USDT", quantity: 2.5, entryPrice: 140, currentPrice: 150 }] });
  const result = await execute(signal, config, portfolio, makeSnapshot("SOL/USDT", 150), 0);
  assert.equal(result.side, "sell");
  assert.equal(result.quantity, 2.5);
  assert.equal(result.price, 150);
});

test("execute 'sell' with no held position returns hold instead of fabricating a quantity", async () => {
  const signal: TradeSignal = { type: "sell", symbol: "SOL/USDT", confidence: 0.9, reason: "test", indicators };
  const result = await execute(signal, config, makePortfolio(), makeSnapshot("SOL/USDT", 150), 0);
  assert.equal(result.side, "hold");
  assert.equal(result.quantity, 0);
});

// ── Post-only take-profit exits (specs/profit-target-roadmap.md §5.8 option a)
//
// The safety invariant these guard: ONLY a take-profit may earn the maker
// rate. A stop-loss resting unfilled while price runs against the position is
// the exact failure mode the risk logic exists to prevent, and a horizon exit
// is a forced close whose whole purpose is happening on time. If either could
// be quietly reclassified as maker, the backtest would under-count the cost of
// precisely the exits that hurt.

const makerConfig: Config = {
  ...config,
  usePostOnlyTakeProfitExits: true,
  simulatedMakerFeePercent: 0.02,
  simulatedTakerFeePercent: 0.055,
};

function sellSignal(reason: string): TradeSignal {
  return { type: "sell", symbol: "SOL/USDT", confidence: 1, reason, indicators };
}

function heldPortfolio(): Portfolio {
  return makePortfolio({
    positions: [{ symbol: "SOL/USDT", quantity: 2, entryPrice: 100, currentPrice: 150 }],
  });
}

test("post-only TP exits: a take-profit sell is charged the MAKER rate", async () => {
  const result = await execute(
    sellSignal("take-profit: 1.5% gain"), makerConfig, heldPortfolio(), makeSnapshot("SOL/USDT", 150), 0,
  );
  assert.equal(result.side, "sell");
  // 2 units x $150 x 0.02%
  assert.ok(Math.abs(result.fee - (2 * 150 * 0.0002)) < 1e-9, `expected maker fee, got ${result.fee}`);
});

test("post-only TP exits: a STOP-LOSS sell is still charged the TAKER rate", async () => {
  const result = await execute(
    sellSignal("stop-loss: 1.5% drop"), makerConfig, heldPortfolio(), makeSnapshot("SOL/USDT", 150), 0,
  );
  assert.ok(Math.abs(result.fee - (2 * 150 * 0.00055)) < 1e-9, `stop-loss must pay taker, got ${result.fee}`);
});

test("post-only TP exits: a HORIZON sell is still charged the TAKER rate", async () => {
  const result = await execute(
    sellSignal("model horizon elapsed (240m) without hitting either barrier"),
    makerConfig, heldPortfolio(), makeSnapshot("SOL/USDT", 150), 0,
  );
  assert.ok(Math.abs(result.fee - (2 * 150 * 0.00055)) < 1e-9, `horizon exit must pay taker, got ${result.fee}`);
});

test("post-only TP exits: an UNRECOGNISED exit reason is charged the TAKER rate", async () => {
  // classifyExitReason() maps anything unknown to "reconciled", never
  // "take_profit" — so an unattributed close cannot sneak into the cheap bucket.
  const result = await execute(
    sellSignal("expert exit: RSI 78.0 (overbought), price above upper band"),
    makerConfig, heldPortfolio(), makeSnapshot("SOL/USDT", 150), 0,
  );
  assert.ok(Math.abs(result.fee - (2 * 150 * 0.00055)) < 1e-9, `unknown exit must pay taker, got ${result.fee}`);
});

test("post-only TP exits: with the flag OFF a take-profit still pays taker", async () => {
  const result = await execute(
    sellSignal("take-profit: 1.5% gain"),
    { ...makerConfig, usePostOnlyTakeProfitExits: false },
    heldPortfolio(), makeSnapshot("SOL/USDT", 150), 0,
  );
  assert.ok(Math.abs(result.fee - (2 * 150 * 0.00055)) < 1e-9, `flag off must pay taker, got ${result.fee}`);
});
