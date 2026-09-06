import { test } from "node:test";
import assert from "node:assert/strict";
import { BybitConnector } from "../src/bybit/connector.ts";

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

  const result = await connector.validateQty("BTC/USDT", 0.0001);
  assert.equal(result, null, "0.0001 BTC should be below min 0.001");
});

test("validateQty rounds qty to nearest step", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("SOLUSDT", { minQty: "0.1", qtyStep: "0.1" });

  // 0.25 rounds to nearest 0.1 step → 0.3 (due to floating point, verify it's close)
  const result = await connector.validateQty("SOL/USDT", 0.25);
  assert(result !== null, "should return a valid qty");
  assert(Math.abs(result - 0.3) < 0.0001, `expected ~0.3 but got ${result}`);
});

test("validateQty returns qty for valid quantity", async () => {
  const connector = new BybitConnector(mockConfig);
  (connector as any).lotSizeCache.set("BTCUSDT", { minQty: "0.001", qtyStep: "0.001" });

  const result = await connector.validateQty("BTC/USDT", 0.5);
  assert.equal(result, 0.5, "0.5 BTC should be valid");
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
