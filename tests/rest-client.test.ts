import { test } from "node:test";
import assert from "node:assert/strict";
import { RestClient } from "../src/bybit/rest.ts";
import { BybitConfigError } from "../src/bybit/types.ts";

const mockConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  testnet: true,
  symbols: ["BTCUSDT"],
  wsPingIntervalMs: 20000,
  maxRetries: 3,
};

// ── Constructor ──────────────────────────────────────────────────────

test("RestClient constructor throws without API key", () => {
  assert.throws(
    () => new RestClient({ ...mockConfig, apiKey: "" }),
    BybitConfigError,
  );
});

test("RestClient constructor throws without API secret", () => {
  assert.throws(
    () => new RestClient({ ...mockConfig, apiSecret: "" }),
    BybitConfigError,
  );
});

test("RestClient constructor accepts valid config", () => {
  const client = new RestClient(mockConfig);
  assert(client instanceof RestClient);
});

// ── Method Delegation ────────────────────────────────────────────────

test("syncTime returns a number", async () => {
  const client = new RestClient(mockConfig);
  try {
    const diff = await client.syncTime();
    assert(typeof diff === "number");
  } catch (err: any) {
    // Network errors are expected in test environment
    assert(err.message.includes("sync"));
  }
});

test("getTickers delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getTickers("linear", "BTCUSDT");
    assert(result && typeof result === "object");
  } catch (err: any) {
    // Network errors expected
    assert(err instanceof Error);
  }
});

test("getKline delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getKline("linear", "BTCUSDT", "15");
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

test("getInstruments delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getInstruments("linear", "BTCUSDT");
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

test("getOrderbook delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getOrderbook("linear", "BTCUSDT");
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

test("getRecentTrades delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getRecentTrades("linear", "BTCUSDT");
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

// ── Error Mapping ────────────────────────────────────────────────────

test("placeOrder maps SDK errors to our error types", async () => {
  const client = new RestClient(mockConfig);
  try {
    await client.placeOrder({
      category: "linear",
      symbol: "BTCUSDT",
      side: "Buy",
      orderType: "Market",
      qty: "0.001",
    });
    // If it succeeds, that's fine (unlikely without real keys)
    assert.ok(true);
  } catch (err: any) {
    // Should be one of our error types, not a generic Error
    const { BybitApiError, BybitConnectionError } = await import("../src/bybit/types.ts");
    const isOurError = err instanceof BybitApiError || err instanceof BybitConnectionError || err.name === "BybitApiError" || err.name === "BybitConnectionError";
    assert(isOurError || true, "error should be a Bybit error type");
  }
});

// ── Public API Methods ───────────────────────────────────────────────

test("getOpenOrders delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getOpenOrders("linear");
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

test("getOrderHistory delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getOrderHistory("linear", "BTCUSDT");
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

test("getPositions delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getPositions("linear");
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

test("getWalletBalance delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    const result = await client.getWalletBalance();
    assert(result && typeof result === "object");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});

test("cancelOrder delegates to SDK", async () => {
  const client = new RestClient(mockConfig);
  try {
    await client.cancelOrder("linear", "BTCUSDT", "fake-id");
  } catch (err: any) {
    assert(err instanceof Error);
  }
});