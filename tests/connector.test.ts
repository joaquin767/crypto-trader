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