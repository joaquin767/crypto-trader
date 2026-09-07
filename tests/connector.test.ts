import { test } from "node:test";
import assert from "node:assert/strict";
import { BybitConnector } from "../src/bybit/connector.ts";
import { getPendingOrders, recordPendingOrder } from "../src/bybit/pending-orders.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  testnet: true,
  symbols: ["BTC/USDT", "ETH/USDT"],
  wsPingIntervalMs: 20000,
  maxRetries: 3,
};

// ── Constructor ──────────────────────────────────────────────────────

test("BybitConnector constructor creates instance", () => {
  const connector = new BybitConnector(mockConfig);
  assert(connector instanceof BybitConnector);
});

test("BybitConnector initial state is disconnected", () => {
  const connector = new BybitConnector(mockConfig);
  assert.equal(connector.state.connected, false);
  assert.equal(connector.state.error, null);
  assert.equal(connector.state.mode, "testnet");
});

test("BybitConnector stores the config", () => {
  const connector = new BybitConnector(mockConfig);
  assert.equal(connector.config.apiKey, "test-key");
  assert.deepEqual(connector.config.symbols, ["BTC/USDT", "ETH/USDT"]);
});

// ── REST Client Access ───────────────────────────────────────────────

test("BybitConnector exposes rest client", () => {
  const connector = new BybitConnector(mockConfig);
  assert(connector.rest);
  assert(typeof connector.rest.syncTime === "function");
});

test("BybitConnector exposes WebSocket clients", () => {
  const connector = new BybitConnector(mockConfig);
  assert(connector.wsPublic);
  assert(connector.wsPrivate);
  assert(typeof connector.wsPublic.subscribe === "function");
  assert(typeof connector.wsPrivate.subscribe === "function");
});

// ── State Management ─────────────────────────────────────────────────

test("state getter returns a copy (immutable)", () => {
  const connector = new BybitConnector(mockConfig);
  const state1 = connector.state;
  const state2 = connector.state;
  assert.notEqual(state1, state2, "state should be a copy");
});

test("state latches initial error as null", () => {
  const connector = new BybitConnector(mockConfig);
  assert.equal(connector.state.error, null);
});

// ── Connection Callbacks ─────────────────────────────────────────────

test("onConnection registers handler without error", () => {
  const connector = new BybitConnector(mockConfig);
  connector.onConnection(() => {});
  assert.ok(true, "handler registered without error");
});

test("onTicker registers handler without error", () => {
  const connector = new BybitConnector(mockConfig);
  connector.onTicker(() => {});
  assert.ok(true, "handler registered without error");
});

test("onTrade registers handler without error", () => {
  const connector = new BybitConnector(mockConfig);
  connector.onTrade(() => {});
  assert.ok(true, "handler registered without error");
});

test("onPosition registers handler without error", () => {
  const connector = new BybitConnector(mockConfig);
  connector.onPosition(() => {});
  assert.ok(true, "handler registered without error");
});

// ── Disconnect ───────────────────────────────────────────────────────

test("disconnect is idempotent", () => {
  const connector = new BybitConnector(mockConfig);
  connector.disconnect();
  connector.disconnect();
  assert.equal(connector.state.connected, false);
});

test("disconnect sets state to disconnected", () => {
  const connector = new BybitConnector(mockConfig);
  connector.disconnect();
  assert.equal(connector.state.connected, false);
});

// ── Place Order Validation ───────────────────────────────────────────

test("validateQty returns null for too-small qty", async () => {
  const connector = new BybitConnector(mockConfig);
  // Mock the lot size cache
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const result = await connector.validateQty("BTC/USDT", 0.0001, "buy");
  assert.equal(result, null, "0.0001 BTC should be below min 0.001");
});

test("validateQty rounds a buy to the nearest step", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("SOLUSDT", { minQty: "0.1", qtyStep: "0.1" });

  // 0.25 rounds to nearest 0.1 step → 0.3 (due to floating point, verify it's close)
  const result = await connector.validateQty("SOL/USDT", 0.25, "buy");
  assert(result !== null, "should return a valid qty");
  assert(Math.abs(result - 0.3) < 0.0001, `expected ~0.3 but got ${result}`);
});

test("validateQty returns qty for valid quantity", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const result = await connector.validateQty("BTC/USDT", 0.5, "buy");
  assert.equal(result, 0.5, "0.5 BTC should be valid");
});

// Regression coverage for the bug where a sell could round UP past the
// quantity actually held — combined with reduceOnly:false (fixed separately),
// that could flip a "close my position" sell into opening a naked short.
// A sell must always round DOWN, never up, even though a buy rounding up is
// fine (it just costs a few extra cents of notional).
test("validateQty rounds a sell DOWN, never up past the held quantity", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("SOLUSDT", { minQty: "0.1", qtyStep: "0.1" });

  // 0.25 would round UP to 0.3 for a buy (see test above) — for a sell it must
  // floor to 0.2, never exceeding what might actually be held.
  const result = await connector.validateQty("SOL/USDT", 0.25, "sell");
  assert(result !== null, "should return a valid qty");
  assert(Math.abs(result - 0.2) < 0.0001, `expected ~0.2 (floored) but got ${result}`);
});

test("validateQty returns null for a sell that floors below the exchange minimum", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.01", qtyStep: "0.001" });

  // 0.0105 floors to 0.010, which is >= minQty 0.01 — should be valid.
  const ok = await connector.validateQty("BTC/USDT", 0.0105, "sell");
  assert(ok !== null && Math.abs(ok - 0.010) < 0.0001);

  // 0.0104 floors to 0.010 too (still valid) — but 0.0049 floors to 0.004,
  // below minQty 0.01, and must be rejected rather than bumped up.
  const tooSmall = await connector.validateQty("BTC/USDT", 0.0049, "sell");
  assert.equal(tooSmall, null);
});

// ── Lot Size Fetching ────────────────────────────────────────────────

test("getMinQty uses cached lot size", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const minQty = await connector.getMinQty("BTC/USDT");
  assert.equal(minQty, 0.001);
});

test("getQtyStep uses cached lot size", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("ETHUSDT", { minQty: "0.01", qtyStep: "0.01" });

  const qtyStep = await connector.getQtyStep("ETH/USDT");
  assert.equal(qtyStep, 0.01);
});

// ── Edge Cases ───────────────────────────────────────────────────────

test("ensureLotSize returns null when fetch fails silently", async () => {
  const connector = new BybitConnector(mockConfig);
  // Mock getInstruments to throw
  const originalGetInstruments = connector.rest.getInstruments;
  connector.rest.getInstruments = async () => { throw new Error("API error"); };

  try {
    const result = await (connector as any).ensureLotSize("BTCUSDT");
    assert.equal(result, null);
  } finally {
    connector.rest.getInstruments = originalGetInstruments;
  }
});

test("ensureLotSize returns null when instruments list is empty", async () => {
  const connector = new BybitConnector(mockConfig);
  const originalGetInstruments = connector.rest.getInstruments;
  connector.rest.getInstruments = async () => ({ category: "linear", list: [] });

  try {
    const result = await (connector as any).ensureLotSize("BTCUSDT");
    assert.equal(result, null);
  } finally {
    connector.rest.getInstruments = originalGetInstruments;
  }
});
// ── Connection State Transitions ────────────────────────────────────

test("connect changes state to connected on success", async () => {
  const connector = new BybitConnector(mockConfig);
  // Mock the REST and WS to avoid real connections
  const originalSyncTime = connector.rest.syncTime;
  connector.rest.syncTime = async () => 0;
  const originalWsConnect = connector.wsPublic.connect;
  connector.wsPublic.connect = async () => {};
  const originalWsPrivateConnect = connector.wsPrivate.connect;
  connector.wsPrivate.connect = async () => {};

  try {
    await connector.connect();
    assert.equal(connector.state.connected, true);
    assert.equal(connector.state.mode, "testnet");
  } finally {
    connector.rest.syncTime = originalSyncTime;
    connector.wsPublic.connect = originalWsConnect;
    connector.wsPrivate.connect = originalWsPrivateConnect;
  }
});

test("connect sets error state on failure", async () => {
  const connector = new BybitConnector(mockConfig);
  connector.rest.syncTime = async () => { throw new Error("Time sync failed"); };

  try {
    await connector.connect();
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.equal(connector.state.connected, false);
    assert(connector.state.error?.includes("Time sync failed"));
  }
});

test("connect sets error state on WebSocket failure", async () => {
  const connector = new BybitConnector(mockConfig);
  connector.rest.syncTime = async () => 0;
  connector.wsPublic.connect = async () => { throw new Error("WS failed"); };

  try {
    await connector.connect();
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.equal(connector.state.connected, false);
    assert(connector.state.error?.includes("WS failed"));
  }
});

// ── Connection Callbacks ────────────────────────────────────────────

test("onConnection handler is called on connect", async () => {
  const connector = new BybitConnector(mockConfig);
  connector.rest.syncTime = async () => 0;
  connector.wsPublic.connect = async () => {};
  connector.wsPrivate.connect = async () => {};
  let connectionState: any = null;
  connector.onConnection((s) => { connectionState = s; });

  try {
    await connector.connect();
    assert(connectionState !== null, "handler should have been called");
    assert.equal(connectionState.connected, true);
  } finally {
    connector.rest.syncTime = async () => 0;
  }
});

test("onConnection handler is called on disconnect", () => {
  const connector = new BybitConnector(mockConfig);
  let callCount = 0;
  connector.onConnection(() => { callCount++; });
  connector.disconnect();
  assert.equal(callCount, 1, "handler should have been called on disconnect");
});

// ── Ticker Handler ──────────────────────────────────────────────────

test("handleTicker dispatches to registered handlers", () => {
  const connector = new BybitConnector(mockConfig);
  let received: any = null;
  connector.onTicker((snapshots) => { received = snapshots; });

  // Access private method
  (connector as any).handleTicker("tickers.BTCUSDT", {
    symbol: "BTCUSDT",
    lastPrice: "40000",
    price24hPcnt: "0.02",
    volume24h: "1000",
  });

  assert(received !== null, "handler should have been called");
  assert(received.has("BTC/USDT"), "should contain BTC/USDT");
  const snapshot = received.get("BTC/USDT");
  assert.equal(snapshot.price, 40000);
});

test("handleTicker handles missing symbol in data (fallback to topic)", () => {
  const connector = new BybitConnector(mockConfig);
  let received: any = null;
  connector.onTicker((snapshots) => { received = snapshots; });

  (connector as any).handleTicker("tickers.BTCUSDT", {
    lastPrice: "41000",
    price24hPcnt: "0.03",
    volume24h: "2000",
  });

  assert(received !== null, "handler should have been called");
  const snapshot = received.get("BTC/USDT");
  assert.equal(snapshot.price, 41000);
});

test("handleTicker does nothing when tickerData is null", () => {
  const connector = new BybitConnector(mockConfig);
  let callCount = 0;
  connector.onTicker(() => { callCount++; });
  (connector as any).handleTicker("tickers.BTCUSDT", null);
  assert.equal(callCount, 0);
});

test("handleTicker does nothing when both symbol and topic lack symbol", () => {
  const connector = new BybitConnector(mockConfig);
  let callCount = 0;
  connector.onTicker(() => { callCount++; });
  (connector as any).handleTicker("invalid", { lastPrice: "40000" });
  assert.equal(callCount, 0);
});

test("handleTicker caches last snapshot for delta merging", () => {
  const connector = new BybitConnector(mockConfig);
  let lastSnapshot: any = null;
  connector.onTicker((snapshots) => { lastSnapshot = snapshots.get("BTC/USDT"); });

  // First call — full data
  (connector as any).handleTicker("tickers.BTCUSDT", {
    symbol: "BTCUSDT", lastPrice: "40000", price24hPcnt: "0.02", volume24h: "1000",
  });
  assert.equal(lastSnapshot?.price, 40000);
  assert.equal(lastSnapshot?.change24h, 2);

  // Second call — delta with only price change
  (connector as any).handleTicker("tickers.BTCUSDT", {
    symbol: "BTCUSDT", lastPrice: "40500",
  });
  assert.equal(lastSnapshot?.price, 40500);
  // Volume should be preserved from previous snapshot
  assert.equal(lastSnapshot?.volume24h, 1000);
});

// ── Order Handler ───────────────────────────────────────────────────

test("handleOrder dispatches filled orders to trade handlers", () => {
  const connector = new BybitConnector(mockConfig);
  let received: any = null;
  connector.onTrade((result) => { received = result; });

  (connector as any).handleOrder({
    symbol: "BTCUSDT",
    orderStatus: "Filled",
    side: "Buy",
    cumExecQty: "0.01",
    cumExecFee: "0.4",
    avgPrice: "40000",
    price: "40000",
    createdTime: String(Date.now()),
  });

  assert(received !== null, "handler should have been called");
  assert.equal(received.symbol, "BTC/USDT");
  assert.equal(received.side, "buy");
});

test("handleOrder ignores non-filled orders", () => {
  const connector = new BybitConnector(mockConfig);
  let callCount = 0;
  connector.onTrade(() => { callCount++; });

  (connector as any).handleOrder({ symbol: "BTCUSDT", orderStatus: "New" });
  assert.equal(callCount, 0);
});

test("handleOrder ignores null data", () => {
  const connector = new BybitConnector(mockConfig);
  let callCount = 0;
  connector.onTrade(() => { callCount++; });
  (connector as any).handleOrder(null);
  assert.equal(callCount, 0);
});

// ── Position Handler ────────────────────────────────────────────────

test("handlePosition dispatches positions to registered handlers", () => {
  const connector = new BybitConnector(mockConfig);
  let received: any = null;
  connector.onPosition((positions) => { received = positions; });

  (connector as any).handlePosition([
    { symbol: "BTCUSDT", size: "0.5", entryPrice: "40000", markPrice: "41000" },
  ]);

  assert(received !== null, "handler should have been called");
  assert(received.length === 1);
  assert.equal(received[0].symbol, "BTC/USDT");
});

// Regression coverage for spec §3.2/§3.4: onPosition's adapted Position type
// has no leverage/liquidationPrice fields, so the leverage-drift and
// liquidation-buffer checks in main.ts need the raw data preserved.
test("handlePosition dispatches unadapted data (with leverage/liquidationPrice intact) to onRawPosition", () => {
  const connector = new BybitConnector(mockConfig);
  let received: any = null;
  connector.onRawPosition((positions) => { received = positions; });

  (connector as any).handlePosition([
    { symbol: "BTCUSDT", size: "0.5", entryPrice: "40000", markPrice: "41000", leverage: "5", liquidationPrice: "35000" },
  ]);

  assert(received !== null, "raw handler should have been called");
  assert.equal(received[0].symbol, "BTCUSDT", "raw handler must NOT get the app-format symbol");
  assert.equal(received[0].leverage, "5");
  assert.equal(received[0].liquidationPrice, "35000");
});

test("handlePosition ignores non-array data", () => {
  const connector = new BybitConnector(mockConfig);
  let callCount = 0;
  connector.onPosition(() => { callCount++; });
  (connector as any).handlePosition({ symbol: "BTCUSDT" });
  assert.equal(callCount, 0);
});

test("handlePosition ignores null data", () => {
  const connector = new BybitConnector(mockConfig);
  let callCount = 0;
  connector.onPosition(() => { callCount++; });
  (connector as any).handlePosition(null);
  assert.equal(callCount, 0);
});

// ── getPositions and getWalletBalance ───────────────────────────────

test("getPositions fetches and converts positions", async () => {
  const connector = new BybitConnector(mockConfig);
  const originalGetPositions = connector.rest.getPositions;
  connector.rest.getPositions = async () => ({
    list: [{ symbol: "BTCUSDT", size: "0.5", entryPrice: "40000", markPrice: "41000", side: "Buy", unrealisedPnl: "0", realisedPnl: "0", liquidationPrice: "0", leverage: "1", positionStatus: "Normal" }],
  });

  try {
    const positions = await connector.getPositions();
    assert.equal(positions.length, 1);
    assert.equal(positions[0]!.symbol, "BTC/USDT");
  } finally {
    connector.rest.getPositions = originalGetPositions;
  }
});

// ── reconcilePositions ───────────────────────────────────────────────
// Regression coverage for the bug where a real exchange position with no
// matching local journal entry was merged straight into the auto-traded
// portfolio. That let the trading loop sell a position the local cash
// ledger never paid for and credit 100% of the proceeds to cashUsd,
// blowing the operating-capital guardrail (an orphaned 33.1 SOL testnet
// position turned $97 of tracked cash into ~$3,560 once sold).

test("reconcilePositions does NOT merge an exchange position absent from the local journal", async () => {
  const connector = new BybitConnector(mockConfig);
  const originalGetPositions = connector.rest.getPositions;
  connector.rest.getPositions = async () => ({
    list: [{ symbol: "SOLUSDT", size: "33.1", entryPrice: "104.8", markPrice: "104.67", side: "Buy", unrealisedPnl: "0", realisedPnl: "0", liquidationPrice: "0", leverage: "1", positionStatus: "Normal" }],
  });

  try {
    const { merged, unaccountedFor, warnings } = await connector.reconcilePositions([]);
    assert.equal(merged.length, 0, "an orphaned exchange position must not enter the tradeable portfolio");
    assert.equal(unaccountedFor.length, 1);
    assert.equal(unaccountedFor[0]!.symbol, "SOL/USDT");
    assert.equal(unaccountedFor[0]!.quantity, 33.1);
    assert(warnings.some(w => w.includes("NOT adopting")));
  } finally {
    connector.rest.getPositions = originalGetPositions;
  }
});

test("reconcilePositions still corrects quantity drift for a locally-tracked position", async () => {
  const connector = new BybitConnector(mockConfig);
  const originalGetPositions = connector.rest.getPositions;
  connector.rest.getPositions = async () => ({
    list: [{ symbol: "SOLUSDT", size: "0.4", entryPrice: "104.8", markPrice: "104.8", side: "Buy", unrealisedPnl: "0", realisedPnl: "0", liquidationPrice: "0", leverage: "1", positionStatus: "Normal" }],
  });

  try {
    const local = [{ symbol: "SOL/USDT", quantity: 0.2, entryPrice: 104.8, currentPrice: 104.8 }];
    const { merged, unaccountedFor } = await connector.reconcilePositions(local);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.quantity, 0.4);
    assert.equal(unaccountedFor.length, 0);
  } finally {
    connector.rest.getPositions = originalGetPositions;
  }
});

test("getWalletBalance fetches and formats balances", async () => {
  const connector = new BybitConnector(mockConfig);
  const originalGetWallet = connector.rest.getWalletBalance;
  connector.rest.getWalletBalance = async () => ({
    list: [{ coin: "USDT", walletBalance: "1000", availableBalance: "800", usdValue: "1000", locked: "200" }],
  });

  try {
    const balances = await connector.getWalletBalance();
    assert.equal(balances.length, 1);
    assert.equal(balances[0]!.coin, "USDT");
    assert.equal(balances[0]!.totalUsd, 1000);
  } finally {
    connector.rest.getWalletBalance = originalGetWallet;
  }
});

// ── placeOrder with lot size ────────────────────────────────────────

test("placeOrder uses minimum qty when validated qty is null", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });
  const originalPlaceOrder = connector.rest.placeOrder;
  let capturedOrder: any = null;
  connector.rest.placeOrder = async (order: any) => {
    capturedOrder = order;
    return { symbol: "BTCUSDT", side: "Buy", cumExecQty: "0.001", cumExecFee: "0", avgPrice: "40000", price: "40000", createdTime: String(Date.now()), orderId: "1", orderLinkId: "1", orderStatus: "Filled", qty: "0.001", leavesQty: "0", cumExecValue: "40" };
  };

  try {
    const signal = { type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    await connector.placeOrder(signal, 0.00001); // very small qty
    assert(capturedOrder !== null, "order should have been placed");
    assert.equal(capturedOrder.qty, "0.0010"); // min qty
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
  }
});

test("placeOrder formats qty with correct precision", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });
  let capturedOrder: any = null;
  const originalPlaceOrder = connector.rest.placeOrder;
  connector.rest.placeOrder = async (order: any) => {
    capturedOrder = order;
    return { symbol: "BTCUSDT", side: "Buy", cumExecQty: "0.5", cumExecFee: "0", avgPrice: "40000", price: "40000", createdTime: String(Date.now()), orderId: "1", orderLinkId: "1", orderStatus: "Filled", qty: "0.5", leavesQty: "0", cumExecValue: "20000" };
  };

  try {
    const signal = { type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    await connector.placeOrder(signal, 0.5);
    assert(capturedOrder !== null);
    assert.equal(capturedOrder.qty, "0.500"); // 3 decimal places for qtyStep 0.001
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
  }
});

// Regression coverage for F2 (specs/live-trading-readiness.md): closing orders
// must carry reduceOnly:true so a local/exchange desync fails safely at the
// exchange instead of opening a naked short.
test("placeOrder sends reduceOnly:true for a sell, false for a buy", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });
  let capturedOrder: any = null;
  const originalPlaceOrder = connector.rest.placeOrder;
  connector.rest.placeOrder = async (order: any) => {
    capturedOrder = order;
    return { symbol: "BTCUSDT", side: order.side, cumExecQty: order.qty, cumExecFee: "0", avgPrice: "40000", price: "40000", createdTime: String(Date.now()), orderId: "1", orderLinkId: "1", orderStatus: "Filled", qty: order.qty, leavesQty: "0", cumExecValue: "40" };
  };

  try {
    const buySignal = { type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    await connector.placeOrder(buySignal, 0.5);
    assert.equal(capturedOrder.reduceOnly, false);

    const sellSignal = { ...buySignal, type: "sell" as const };
    await connector.placeOrder(sellSignal, 0.5);
    assert.equal(capturedOrder.reduceOnly, true);
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
  }
});

// Regression coverage: a sell whose quantity floors below the exchange minimum
// must be skipped (hold), never bumped up to minQty — bumping up a close is
// exactly the "sell more than is held" bug this section exists to prevent.
test("placeOrder skips (holds) a sell that floors below the exchange minimum, never bumps it up", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.01", qtyStep: "0.001" });
  let placeOrderCalled = false;
  const originalPlaceOrder = connector.rest.placeOrder;
  connector.rest.placeOrder = async (order: any) => {
    placeOrderCalled = true;
    return { symbol: "BTCUSDT", side: order.side, cumExecQty: order.qty, cumExecFee: "0", avgPrice: "40000", price: "40000", createdTime: String(Date.now()), orderId: "1", orderLinkId: "1", orderStatus: "Filled", qty: order.qty, leavesQty: "0", cumExecValue: "40" };
  };

  try {
    const sellSignal = { type: "sell" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    const result = await connector.placeOrder(sellSignal, 0.0049); // floors to 0.004, below minQty 0.01
    assert.equal(result.side, "hold");
    assert.equal(placeOrderCalled, false, "must never call the exchange with a bumped-up sell quantity");
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
  }
});

// ── ensureLeverageAndMargin ───────────────────────────────────────────
// Regression coverage for spec §3.1 — the leverage pin is what makes the
// cash guardrail's "notional = capital at risk" assumption actually true on
// a leveraged product. These tests exercise the three outcomes: clean
// success, an idempotent "already set" rejection (must not be fatal), and a
// position blocking the change (must restrict that symbol, not halt
// everything) — plus the genuinely-fatal case where nothing can be confirmed.

function withMocked(connector: BybitConnector, overrides: Record<string, any>, fn: () => Promise<void>) {
  const originals: Record<string, any> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = (connector.rest as any)[key];
    (connector.rest as any)[key] = overrides[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(overrides)) (connector.rest as any)[key] = originals[key];
  });
}

test("ensureLeverageAndMargin succeeds cleanly when there are no open positions", async () => {
  const connector = new BybitConnector(mockConfig);
  await withMocked(connector, {
    setLeverage: async () => {},
    setMarginMode: async () => {},
    getPositions: async () => ({ list: [] }),
  }, async () => {
    const result = await connector.ensureLeverageAndMargin();
    assert.equal(result.ok, true);
    assert.deepEqual(result.restrictedSymbols, []);
  });
});

test("ensureLeverageAndMargin treats an 'already set' rejection as success, not failure", async () => {
  const connector = new BybitConnector(mockConfig);
  await withMocked(connector, {
    setLeverage: async () => { throw new Error("leverage not modified"); },
    setMarginMode: async () => { throw new Error("Margin mode is already set"); },
    getPositions: async () => ({ list: [] }),
  }, async () => {
    const result = await connector.ensureLeverageAndMargin();
    assert.equal(result.ok, true, "an idempotent 'no change needed' rejection must not be treated as failure");
  });
});

test("ensureLeverageAndMargin restricts (does not halt) a symbol whose open position blocks the leverage change", async () => {
  const connector = new BybitConnector(mockConfig);
  await withMocked(connector, {
    setLeverage: async (_cat: string, symbol: string) => {
      if (symbol === "BTC/USDT") throw new Error("leverage cannot be changed while a position is open");
    },
    setMarginMode: async () => {},
    getPositions: async () => ({
      list: [
        { symbol: "BTCUSDT", side: "Buy", size: "0.01", entryPrice: "40000", markPrice: "40000", unrealisedPnl: "0", realisedPnl: "0", liquidationPrice: "0", leverage: "5", positionStatus: "Normal" },
      ],
    }),
  }, async () => {
    const result = await connector.ensureLeverageAndMargin();
    assert.equal(result.ok, true, "a restricted symbol is not the same as a fatal failure");
    assert.deepEqual(result.restrictedSymbols, ["BTC/USDT"]);
  });
});

test("ensureLeverageAndMargin ignores flat (zero-size) positions when checking leverage", async () => {
  const connector = new BybitConnector(mockConfig);
  await withMocked(connector, {
    setLeverage: async () => {},
    setMarginMode: async () => {},
    getPositions: async () => ({
      list: [
        { symbol: "BTCUSDT", side: "Buy", size: "0", entryPrice: "0", markPrice: "40000", unrealisedPnl: "0", realisedPnl: "0", liquidationPrice: "0", leverage: "10", positionStatus: "Normal" },
      ],
    }),
  }, async () => {
    const result = await connector.ensureLeverageAndMargin();
    assert.equal(result.ok, true);
    assert.deepEqual(result.restrictedSymbols, [], "a flat position's stale leverage field must not restrict the symbol");
  });
});

test("ensureLeverageAndMargin is fatal when margin mode can't be confirmed at all", async () => {
  const connector = new BybitConnector(mockConfig);
  await withMocked(connector, {
    setLeverage: async () => {},
    setMarginMode: async () => { throw new Error("insufficient permissions"); },
    getPositions: async () => ({ list: [] }),
  }, async () => {
    const result = await connector.ensureLeverageAndMargin();
    assert.equal(result.ok, false);
  });
});

test("ensureLeverageAndMargin is fatal when position leverage can't be read back at all", async () => {
  const connector = new BybitConnector(mockConfig);
  await withMocked(connector, {
    setLeverage: async () => {},
    setMarginMode: async () => {},
    getPositions: async () => { throw new Error("network error"); },
  }, async () => {
    const result = await connector.ensureLeverageAndMargin();
    assert.equal(result.ok, false, "if the safety invariant can't be confirmed, it must not be assumed true");
  });
});

// ── getFundingPnlSince ─────────────────────────────────────────────────
// Regression coverage for spec §3.3. Sign convention is explicitly flagged
// as unverified in the implementation (see connector.ts) — these tests pin
// down the *current* documented behavior (negate execFee) so a future change
// to that constant is a deliberate, visible diff rather than a silent drift.

test("getFundingPnlSince sums execFee (negated) across all configured symbols", async () => {
  const connector = new BybitConnector(mockConfig); // symbols: BTC/USDT, ETH/USDT
  const originalGetFundingHistory = connector.rest.getFundingHistory;
  connector.rest.getFundingHistory = async (_category: string, symbol: string) => {
    if (symbol === "BTC/USDT") return { list: [{ execFee: "1.5" }, { execFee: "-0.5" }] };
    return { list: [{ execFee: "2" }] };
  };

  try {
    const total = await connector.getFundingPnlSince(0);
    // Raw sum: 1.5 - 0.5 + 2 = 3; negated per the current (unverified) convention → -3.
    assert.equal(total, -3);
  } finally {
    connector.rest.getFundingHistory = originalGetFundingHistory;
  }
});

test("getFundingPnlSince skips a symbol whose fetch fails, rather than failing entirely", async () => {
  const connector = new BybitConnector(mockConfig);
  const originalGetFundingHistory = connector.rest.getFundingHistory;
  connector.rest.getFundingHistory = async (_category: string, symbol: string) => {
    if (symbol === "BTC/USDT") throw new Error("network error");
    return { list: [{ execFee: "1" }] };
  };

  try {
    const total = await connector.getFundingPnlSince(0);
    assert.equal(total, -1); // only ETH/USDT's entry counted
  } finally {
    connector.rest.getFundingHistory = originalGetFundingHistory;
  }
});

test("getFundingPnlSince ignores unparseable execFee values", async () => {
  const connector = new BybitConnector(mockConfig);
  const originalGetFundingHistory = connector.rest.getFundingHistory;
  connector.rest.getFundingHistory = async () => ({ list: [{ execFee: "not-a-number" }, { execFee: "2" }] });

  try {
    const total = await connector.getFundingPnlSince(0);
    assert.equal(total, -4); // two symbols × 2, negated — the malformed entry contributes 0
  } finally {
    connector.rest.getFundingHistory = originalGetFundingHistory;
  }
});

// ── Partial fills (spec §4.3) ──────────────────────────────────────────
// Regression coverage: previously pollForFill only ever accepted
// orderStatus === "Filled" — a PartiallyFilled match was silently ignored on
// every attempt, exhausting the retry window and surfacing
// BybitFillUncertainError even though real (partial) exchange exposure
// existed with zero local record of it.

test("placeOrder journals a partial fill discovered while polling, exactly once", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const originalPlaceOrder = connector.rest.placeOrder;
  const originalGetOrderHistory = connector.rest.getOrderHistory;
  let historyCallCount = 0;

  connector.rest.placeOrder = async () => ({
    // Ambiguous initial ack — unparseable fill fields, forces polling.
    symbol: "BTCUSDT", side: "Buy", cumExecQty: "", cumExecFee: "", avgPrice: "", price: "",
    createdTime: String(Date.now()), orderId: "order-1", orderLinkId: "link-1",
    orderStatus: "New", qty: "0.01", leavesQty: "0.01",
  });
  connector.rest.getOrderHistory = async () => {
    historyCallCount++;
    return {
      list: [{
        orderId: "order-1", symbol: "BTCUSDT", side: "Buy",
        orderStatus: "PartiallyFilled",
        cumExecQty: "0.004", cumExecFee: "0.002", avgPrice: "40000", price: "40000",
        leavesQty: "0.006", createdTime: String(Date.now()),
      }],
    };
  };

  try {
    const signal = { type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    const result = await connector.placeOrder(signal, 0.01);
    assert.equal(result.side, "buy");
    assert.equal(result.quantity, 0.004, "must journal exactly the partial quantity that actually filled, not the requested qty");
    assert(historyCallCount > 0, "must have polled order history at least once");
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
    connector.rest.getOrderHistory = originalGetOrderHistory;
  }
});

test("placeOrder still surfaces BybitFillUncertainError when polling never finds any match", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const originalPlaceOrder = connector.rest.placeOrder;
  const originalGetOrderHistory = connector.rest.getOrderHistory;
  connector.rest.placeOrder = async () => ({
    symbol: "BTCUSDT", side: "Buy", cumExecQty: "", cumExecFee: "", avgPrice: "", price: "",
    createdTime: String(Date.now()), orderId: "order-2", orderLinkId: "link-2",
    orderStatus: "New", qty: "0.01", leavesQty: "0.01",
  });
  connector.rest.getOrderHistory = async () => ({ list: [] }); // order never shows up

  try {
    const signal = { type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    await assert.rejects(() => connector.placeOrder(signal, 0.01));
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
    connector.rest.getOrderHistory = originalGetOrderHistory;
  }
});

// ── Pending-order durability (spec §8.2) ────────────────────────────────

test("placeOrder records a pending order before sending, and clears it once resolved", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const originalPlaceOrder = connector.rest.placeOrder;
  let pendingDuringSend = -1;
  connector.rest.placeOrder = async () => {
    pendingDuringSend = getPendingOrders().length;
    return { symbol: "BTCUSDT", side: "Buy", cumExecQty: "0.01", cumExecFee: "0", avgPrice: "40000", price: "40000", createdTime: String(Date.now()), orderId: "order-3", orderLinkId: "link-3", orderStatus: "Filled", qty: "0.01", leavesQty: "0" };
  };

  try {
    const signal = { type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    await connector.placeOrder(signal, 0.01);
    assert.equal(pendingDuringSend, 1, "a pending-order record must exist while the request is in flight");
    assert.equal(getPendingOrders().length, 0, "the pending record must be cleared once the order resolves");
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
  }
});

test("placeOrder clears the pending-order record even when the exchange rejects the order", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const originalPlaceOrder = connector.rest.placeOrder;
  connector.rest.placeOrder = async () => { throw new Error("rejected"); };

  try {
    const signal = { type: "buy" as const, symbol: "BTC/USDT", confidence: 0.8, reason: "test", indicators: { rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false }, bollinger: { upper: 50000, middle: 40000, lower: 30000, width: 0.5 }, momentum: 0, atr: 100 } };
    await assert.rejects(() => connector.placeOrder(signal, 0.01));
    assert.equal(getPendingOrders().length, 0, "a rejected order must not leave a stale pending record behind");
  } finally {
    connector.rest.placeOrder = originalPlaceOrder;
  }
});

// ── checkPendingOrders (spec §8.2) ──────────────────────────────────────

function withTempCwd(fn: () => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "connector-pending-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  return Promise.resolve(fn()).finally(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });
}

test("checkPendingOrders flags a pending order that actually filled, and clears the record", () => withTempCwd(async () => {
  const connector = new BybitConnector(mockConfig);
  recordPendingOrder({ orderLinkId: "link-x", symbol: "BTCUSDT", intent: "buy", expectedQty: 0.01, timestamp: Date.now() });

  const originalGetOrderHistory = connector.rest.getOrderHistory;
  connector.rest.getOrderHistory = async () => ({
    list: [{ orderId: "1", orderLinkId: "link-x", orderStatus: "Filled", cumExecQty: "0.01", avgPrice: "40000", price: "40000" }],
  });

  try {
    const warnings = await connector.checkPendingOrders();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /was actually Filled on Bybit/);
    assert.equal(getPendingOrders().length, 0, "the pending record must be cleared after checking, resolved or not");
  } finally {
    connector.rest.getOrderHistory = originalGetOrderHistory;
  }
}));

test("checkPendingOrders reports a confirmed-cancelled order as safe to disregard", () => withTempCwd(async () => {
  const connector = new BybitConnector(mockConfig);
  recordPendingOrder({ orderLinkId: "link-y", symbol: "BTCUSDT", intent: "buy", expectedQty: 0.01, timestamp: Date.now() });

  const originalGetOrderHistory = connector.rest.getOrderHistory;
  connector.rest.getOrderHistory = async () => ({
    list: [{ orderId: "1", orderLinkId: "link-y", orderStatus: "Cancelled" }],
  });

  try {
    const warnings = await connector.checkPendingOrders();
    assert.match(warnings[0]!, /safe to disregard/);
  } finally {
    connector.rest.getOrderHistory = originalGetOrderHistory;
  }
}));

test("checkPendingOrders returns nothing when there are no pending orders", () => withTempCwd(async () => {
  const connector = new BybitConnector(mockConfig);
  const warnings = await connector.checkPendingOrders();
  assert.deepEqual(warnings, []);
}));
