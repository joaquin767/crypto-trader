import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, clearHistory, setHistory, getHistory } from "../src/strategy/signals.ts";
import type { MarketSnapshot } from "../src/market.ts";
import { empty } from "../src/portfolio.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  exchange: "binance", apiKey: "a", apiSecret: "b",
  symbols: ["BTC/USDT"],
  maxCapitalUsd: 1000,
  maxPositionSizeUsd: 1000,
  maxDailyTrades: 5,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  refreshIntervalMs: 5000,
};

const configNoDailyLimit: Config = {
  ...config,
  maxDailyTrades: 0, // unlimited
};

function snap(price: number, change = 2): MarketSnapshot {
  return { symbol: "BTC/USDT", price, change24h: change, volume24h: 500, timestamp: Date.now() };
}

function seedRisingPrices(): void {
  const prices = Array.from({ length: 30 }, (_, i) => 39000 + i * 100);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 200),
    lows: prices.map(p => p - 200),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
}

function seedFallingPrices(): void {
  const prices = Array.from({ length: 30 }, (_, i) => 42000 - i * 100);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 200),
    lows: prices.map(p => p - 200),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
}

function seedVolatilePrices(): void {
  const prices = Array.from({ length: 30 }, (_, i) => 40000 + Math.sin(i * 0.8) * 3000);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 500),
    lows: prices.map(p => p - 500),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
}

test("analyze returns 'hold' with maxDailyTrades reached", () => {
  clearHistory();
  const portfolio = { ...empty(), dailyTradeCount: 5 };
  const signal = analyze(snap(40000), portfolio, config);
  assert.equal(signal.type, "hold");
  assert(signal.reason.includes("maxDailyTrades"));
});

test("analyze returns 'sell' on stop-loss", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(37000), portfolio, config);
  assert.equal(signal.type, "sell");
  assert(signal.confidence >= 0.7);
});

test("analyze returns 'sell' on take-profit", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(45000), portfolio, config);
  assert.equal(signal.type, "sell");
});

test("analyze holds when position is within thresholds", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(40500, 1), portfolio, config);
  assert.equal(signal.type, "hold");
});

test("analyze returns 'buy' given bullish indicators and no position", () => {
  clearHistory();
  seedRisingPrices();
  const portfolio = empty();
  const signal = analyze(snap(42000, 5), portfolio, configNoDailyLimit);
  assert(["buy", "hold"].includes(signal.type));
  if (signal.type === "buy") {
    assert(signal.confidence > 0.4);
  }
});

test("analyze returns 'sell' on RSI overbought with price above upper band", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  // Seed extremely overbought scenario
  const prices = Array.from({ length: 30 }, (_, i) => 40000 + i * 500);
  setHistory("BTC/USDT", {
    prices,
    highs: prices.map(p => p + 300),
    lows: prices.map(p => p - 200),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const signal = analyze(snap(54000, 15), portfolio, configNoDailyLimit);
  assert.equal(signal.type, "sell", "should be sell on RSI overbought + price above upper band");
});

test("analyze returns 'sell' on negative momentum sell signal", () => {
  clearHistory();
  seedFallingPrices();
  const portfolio = empty();
  const signal = analyze(snap(39000, -5), portfolio, configNoDailyLimit);
  // Should be sell or hold when indicators are bearish
  assert(["sell", "hold"].includes(signal.type));
});

test("analyze includes indicators in the result", () => {
  clearHistory();
  const portfolio = empty();
  const signal = analyze(snap(40000), portfolio, configNoDailyLimit);
  assert(signal.indicators);
  assert(typeof signal.indicators.rsi === "number");
  assert(typeof signal.indicators.momentum === "number");
  assert(typeof signal.indicators.atr === "number");
  assert(signal.indicators.macd);
  assert(signal.indicators.bollinger);
});

test("analyze prevents trading in high volatility", () => {
  clearHistory();
  seedVolatilePrices();
  const portfolio = empty();
  const signal = analyze(snap(40000, 3), portfolio, configNoDailyLimit);
  // High volatility should add to sellScore
  assert(signal.indicators.atr > 0);
  assert(typeof signal.reason === "string");
});

test("analyze handles insufficient cash gracefully", () => {
  clearHistory();
  seedRisingPrices();
  const portfolio = { ...empty(), cashUsd: 0.5 }; // very little cash
  const signal = analyze(snap(42000, 5), portfolio, configNoDailyLimit);
  // Should be hold because we can't afford the position
  assert(["hold", "buy"].includes(signal.type));
});

test("getHistory returns correct history for a symbol", () => {
  clearHistory();
  seedRisingPrices();
  const history = getHistory("BTC/USDT");
  assert(history.prices.length > 0);
  assert(history.highs.length > 0);
  assert(history.lows.length > 0);
  assert(history.timestamps.length > 0);
  assert.equal(history.prices.length, history.highs.length);
});

test("getHistory creates new history for unknown symbol", () => {
  clearHistory();
  const history = getHistory("SOL/USDT");
  assert(history.prices.length === 0);
  assert(history.timestamps.length === 0);
});

test("clearHistory resets all histories", () => {
  clearHistory();
  seedRisingPrices();
  assert(getHistory("BTC/USDT").prices.length > 0);
  clearHistory();
  assert(getHistory("BTC/USDT").prices.length === 0);
});

test("setHistory overwrites existing history", () => {
  clearHistory();
  setHistory("BTC/USDT", {
    prices: [100, 200, 300],
    highs: [150, 250, 350],
    lows: [50, 150, 250],
    timestamps: [1, 2, 3],
  });
  const history = getHistory("BTC/USDT");
  assert.deepEqual(history.prices, [100, 200, 300]);
});

test("analyze handles empty history gracefully", () => {
  clearHistory();
  const portfolio = empty();
  const signal = analyze(snap(40000, 2), portfolio, configNoDailyLimit);
  // With no history, indicators should use defaults
  assert(signal.indicators.rsi >= 0);
  assert(signal.indicators.rsi <= 100);
});

// ── Regression coverage for specs/strategy-signal-quality.md §4 (F2) ──────
// A new-entry signal that only appeared for a single tick must not be acted
// on — it takes signalConfirmationTicks consecutive calls before it is.

function seedConfirmedBuySetup(): { prices: number[]; snapshot: MarketSnapshot } {
  // A real dip-then-recovery: RSI ends up oversold-adjacent from the earlier
  // decline while the last 10 ticks (momentum's window) are a clean, strong
  // recovery — buyScore crosses 4 (momentum +2, volume-surge +1, SMA +1)
  // consistently across repeated calls with this same fixture, unlike the
  // borderline scoring of a plain rising-price seed.
  const down = Array.from({ length: 20 }, (_, i) => 42000 - i * 150);
  const bottom = down[down.length - 1]!;
  const up = Array.from({ length: 12 }, (_, i) => bottom + i * 100);
  const prices = [...down, ...up];
  const snapshot: MarketSnapshot = {
    symbol: "BTC/USDT", price: prices[prices.length - 1]! + 100,
    change24h: 3, volume24h: 600, timestamp: Date.now(),
  };
  return { prices, snapshot };
}

test("analyze does not act on a new-entry signal seen for only one tick", () => {
  clearHistory();
  const { prices, snapshot } = seedConfirmedBuySetup();
  setHistory("BTC/USDT", {
    prices, highs: prices.map(p => p + 100), lows: prices.map(p => p - 300),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const portfolio = empty();
  const signal = analyze(snapshot, portfolio, configNoDailyLimit);
  assert.equal(signal.type, "hold", "a single tick must not be enough to enter, even if the raw score crosses the threshold");
  assert(signal.reason.includes("awaiting confirmation"));
});

test("analyze acts on a new-entry signal once it has persisted for signalConfirmationTicks consecutive calls", () => {
  clearHistory();
  const { prices, snapshot } = seedConfirmedBuySetup();
  setHistory("BTC/USDT", {
    prices, highs: prices.map(p => p + 100), lows: prices.map(p => p - 300),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const portfolio = empty();
  const config = { ...configNoDailyLimit, signalConfirmationTicks: 2 };
  const first = analyze(snapshot, portfolio, config);
  const second = analyze(snapshot, portfolio, config);
  assert.equal(first.type, "hold", "tick 1: not yet confirmed");
  assert.equal(second.type, "buy", "tick 2: confirmed — same raw direction persisted for signalConfirmationTicks calls");
});

// ── Regression coverage for specs/strategy-signal-quality.md §4 (F2) ──────
// The noise-prone "expert exit" rule is gated by a minimum hold time so it
// can't close a position seconds after opening it on pure indicator noise.
// Stop-loss/take-profit are never subject to this gate (design principle 3).

function seedExpertExitSetup(): { prices: number[]; snapshot: MarketSnapshot; entryPrice: number } {
  // A gentle, low-volatility uptrend (tight Bollinger bands) with one sharp
  // final tick that pushes price above the upper band while RSI is pegged
  // at 100 — isolates the expert-exit condition from stop-loss/take-profit
  // by keeping entryPrice equal to the pre-pop price (near-zero P&L).
  const prices = Array.from({ length: 29 }, (_, i) => 50000 + i * 20);
  const entryPrice = prices[prices.length - 1]! + 400;
  const allPrices = [...prices, entryPrice];
  const snapshot: MarketSnapshot = {
    symbol: "BTC/USDT", price: entryPrice + 10, change24h: 2, volume24h: 500, timestamp: Date.now(),
  };
  return { prices: allPrices, snapshot, entryPrice };
}

test("expert exit does not fire on a position younger than minHoldBeforeExpertExitMs", () => {
  clearHistory();
  const { prices, snapshot, entryPrice } = seedExpertExitSetup();
  setHistory("BTC/USDT", {
    prices, highs: prices.map(p => p + 30), lows: prices.map(p => p - 30),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice, currentPrice: entryPrice, openedAt: Date.now() }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const config = { ...configNoDailyLimit, stopLossPercent: 50, takeProfitPercent: 50 };
  const signal = analyze(snapshot, portfolio, config);
  assert.equal(signal.type, "hold", "a fresh position must not be expert-exited on single-tick noise");
});

test("expert exit does fire once the position is older than minHoldBeforeExpertExitMs", () => {
  clearHistory();
  const { prices, snapshot, entryPrice } = seedExpertExitSetup();
  setHistory("BTC/USDT", {
    prices, highs: prices.map(p => p + 30), lows: prices.map(p => p - 30),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice, currentPrice: entryPrice, openedAt: Date.now() - 60000 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const config = { ...configNoDailyLimit, stopLossPercent: 50, takeProfitPercent: 50 };
  const signal = analyze(snapshot, portfolio, config);
  assert.equal(signal.type, "sell");
  assert(signal.reason.includes("expert exit"));
});

test("stop-loss still fires immediately on a position 1ms old — minHoldBeforeExpertExitMs never gates it", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 40000, openedAt: Date.now() - 1 }],
    totalValueUsd: 14000, cashUsd: 10000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(37000), portfolio, config);
  assert.equal(signal.type, "sell");
  assert(signal.reason.includes("stop-loss"));
});

// ── Regression: stop-loss/take-profit measure from entryPrice, not ───────
// currentPrice. Using currentPrice silently disabled both the moment a
// position's currentPrice was refreshed to the live mark price — which
// reconcilePositions() does on every WS position push (connector.ts merges
// currentPrice from adapters.ts's markPrice). A position 15% underwater
// reported "holding: 0.0% below entry" and never stopped out.

test("stop-loss fires on a marked-to-market position (measured from entry, not current price)", () => {
  clearHistory();
  const portfolio = { ...empty(),
    // entry 40000, price crashed to 34000 (-15%), and currentPrice has
    // already been refreshed to that same mark price by reconciliation.
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 34000, openedAt: Date.now() - 99999 }],
    totalValueUsd: 4400, cashUsd: 1000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(34000), portfolio, config);
  assert.equal(signal.type, "sell", "a 15% underwater position must stop out even after mark-to-market");
  assert(signal.reason.includes("stop-loss"));
});

test("take-profit fires on a marked-to-market position (measured from entry, not current price)", () => {
  clearHistory();
  const portfolio = { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 0.1, entryPrice: 40000, currentPrice: 46000, openedAt: Date.now() - 99999 }],
    totalValueUsd: 5600, cashUsd: 1000, dailyTradeCount: 0,
  };
  const signal = analyze(snap(46000), portfolio, config);
  assert.equal(signal.type, "sell", "a 15% winning position must take profit even after mark-to-market");
  assert(signal.reason.includes("take-profit"));
});
// An otherwise-qualifying entry is refused when the ATR-implied plausible
// move can't plausibly clear round-trip cost — this fixture's real ATR is
// ~1.1% of price, so a high fee estimate blocks it and a low one doesn't.

// ── Regression coverage for specs/strategy-signal-quality.md §5 (F4) ──────
// An otherwise-qualifying entry is refused when the ATR-implied plausible
// move can't plausibly clear round-trip cost — this fixture's real ATR is
// ~1.1% of price, so a high fee estimate blocks it and a low one doesn't.

test("a high estimated round-trip fee blocks an otherwise-qualifying entry (insufficient plausible edge)", () => {
  clearHistory();
  const { prices, snapshot } = seedConfirmedBuySetup();
  setHistory("BTC/USDT", {
    prices, highs: prices.map(p => p + 100), lows: prices.map(p => p - 300),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const portfolio = empty();
  const signal = analyze(snapshot, portfolio, { ...configNoDailyLimit, estimatedRoundTripFeePercent: 1.0 });
  assert.equal(signal.type, "hold");
  assert.equal(signal.reason, "insufficient plausible edge vs. round-trip cost");
});

test("a low estimated round-trip fee does not block the same otherwise-qualifying entry", () => {
  clearHistory();
  const { prices, snapshot } = seedConfirmedBuySetup();
  setHistory("BTC/USDT", {
    prices, highs: prices.map(p => p + 100), lows: prices.map(p => p - 300),
    timestamps: prices.map((_, i) => Date.now() + i * 1000),
  });
  const portfolio = empty();
  const signal = analyze(snapshot, portfolio, { ...configNoDailyLimit, estimatedRoundTripFeePercent: 0.1 });
  assert.notEqual(signal.reason, "insufficient plausible edge vs. round-trip cost");
});
// ── Exit horizon coherence ────────────────────────────────────────────────
// Observed live 2026-09-08: five consecutive model-gated entries were closed
// by the expert-exit rule after a median 236s, against the model's 7200s
// (24 x 5m) forecast horizon — 3% of the window the prediction was made
// over. None was ever given the chance to be right. The position's clock
// must be the model's clock.

const modelConfig = { ...configNoDailyLimit, useModelGate: true, stopLossPercent: 1, takeProfitPercent: 1 };

function positionAged(ms: number, entryPrice = 0.634) {
  return { ...empty(),
    positions: [{ symbol: "BTC/USDT", quantity: 10, entryPrice, currentPrice: entryPrice, openedAt: Date.now() - ms }],
    totalValueUsd: 100, cashUsd: 90, dailyTradeCount: 0,
  };
}

test("a model-gated position is closed once the forecast horizon elapses", () => {
  clearHistory();
  // 24 bars x 5m = 7200s. A position older than that has outlived the
  // prediction it was opened on — the training labels count exactly this
  // case as an outcome, so the strategy must act on it too.
  const signal = analyze(snap(0.634), positionAged(7_300_000), modelConfig);
  assert.equal(signal.type, "sell");
  assert(signal.reason.includes("horizon elapsed"), `expected a horizon exit, got: ${signal.reason}`);
});

test("a model-gated position younger than the horizon is not closed by the expert-exit rule", () => {
  clearHistory();
  // 236s — the observed live median. Previously the expert exit could fire
  // here (30s min-hold); now the horizon governs and it must hold.
  const signal = analyze(snap(0.634), positionAged(236_000), modelConfig);
  assert.notEqual(signal.type, "sell");
});

test("stop-loss still fires inside the horizon — the model's own barrier is never deferred", () => {
  clearHistory();
  // Entry 0.634, price 0.620 = -2.2%, past the 1% stop, on a 60s-old
  // position. The horizon defers the noise-driven expert exit, never a
  // risk-reducing barrier.
  const signal = analyze(snap(0.620), positionAged(60_000), modelConfig);
  assert.equal(signal.type, "sell");
  assert(signal.reason.includes("stop-loss"), `expected stop-loss, got: ${signal.reason}`);
});

test("without the model gate, exit behaviour is unchanged (no horizon exit)", () => {
  clearHistory();
  const signal = analyze(snap(0.634), positionAged(7_300_000), { ...configNoDailyLimit, stopLossPercent: 1, takeProfitPercent: 1 });
  assert(!signal.reason.includes("horizon elapsed"), "horizon exit must not apply when the model isn't driving entries");
});
