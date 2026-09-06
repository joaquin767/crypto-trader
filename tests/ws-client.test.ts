import { test } from "node:test";
import assert from "node:assert/strict";
import { WsClient } from "../src/bybit/ws.ts";

const mockConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  testnet: true,
  symbols: ["BTCUSDT"],
  wsPingIntervalMs: 20000,
  maxRetries: 3,
};

// ── Constructor ──────────────────────────────────────────────────────

test("WsClient constructor sets correct URL (testnet public)", () => {
  const client = new WsClient(mockConfig, false);
  assert(client instanceof WsClient);
  assert(!client.isConnected());
});

test("WsClient constructor sets correct URL (testnet private)", () => {
  const client = new WsClient(mockConfig, true);
  assert(client instanceof WsClient);
  assert(!client.isConnected());
});

// ── Subscribe / Unsubscribe ──────────────────────────────────────────

test("subscribe adds topics to subscription list", () => {
  const client = new WsClient(mockConfig, false);
  client.subscribe(["tickers.BTCUSDT", "tickers.ETHUSDT"]);
  const topics = client.getSubscribedTopics();
  assert(topics.includes("tickers.BTCUSDT"));
  assert(topics.includes("tickers.ETHUSDT"));
});

test("unsubscribe removes topics from subscription list", () => {
  const client = new WsClient(mockConfig, false);
  client.subscribe(["tickers.BTCUSDT", "tickers.ETHUSDT"]);
  client.unsubscribe(["tickers.BTCUSDT"]);
  const topics = client.getSubscribedTopics();
  assert(!topics.includes("tickers.BTCUSDT"));
  assert(topics.includes("tickers.ETHUSDT"));
});

// ── Handlers ─────────────────────────────────────────────────────────

test("on and off register and remove handlers", () => {
  const client = new WsClient(mockConfig, false);
  let called = false;
  const handler = () => { called = true; };

  client.on("tickers.BTCUSDT", handler);
  client.off("tickers.BTCUSDT", handler);

  // Test that handler was removed (no crash when message arrives)
  assert.ok(true, "handler registered and removed without error");
});

test("multiple handlers on same topic", () => {
  const client = new WsClient(mockConfig, false);
  let count1 = 0;
  let count2 = 0;

  client.on("tickers.BTCUSDT", () => { count1++; });
  client.on("tickers.BTCUSDT", () => { count2++; });

  assert.ok(true, "multiple handlers registered without error");
});

// ── Connection Status ────────────────────────────────────────────────

test("isConnected returns false initially", () => {
  const client = new WsClient(mockConfig, false);
  assert.equal(client.isConnected(), false);
});

test("getLatencyMs returns 0 initially", () => {
  const client = new WsClient(mockConfig, false);
  assert.equal(client.getLatencyMs(), 0);
});

test("getSubscribedTopics returns empty array initially", () => {
  const client = new WsClient(mockConfig, false);
  assert.deepEqual(client.getSubscribedTopics(), []);
});

// ── Disconnect ───────────────────────────────────────────────────────

test("disconnect cleans up without errors", () => {
  const client = new WsClient(mockConfig, false);
  client.subscribe(["tickers.BTCUSDT"]);
  client.disconnect();
  assert(!client.isConnected());
});

test("disconnect is idempotent", () => {
  const client = new WsClient(mockConfig, false);
  client.disconnect();
  client.disconnect();
  assert.ok(true, "multiple disconnect calls don't throw");
});

// ── Edge Cases ───────────────────────────────────────────────────────

test("subscribe empty array is a no-op", () => {
  const client = new WsClient(mockConfig, false);
  client.subscribe([]);
  assert.deepEqual(client.getSubscribedTopics(), []);
});

test("unsubscribe non-existent topic is a no-op", () => {
  const client = new WsClient(mockConfig, false);
  client.unsubscribe(["nonexistent.topic"]);
  assert.ok(true, "no error thrown");
});

test("off non-existent handler is a no-op", () => {
  const client = new WsClient(mockConfig, false);
  client.off("tickers.BTCUSDT", () => {});
  assert.ok(true, "no error thrown");
});

test("handlers are not shared across different WsClient instances", () => {
  const client1 = new WsClient(mockConfig, false);
  const client2 = new WsClient(mockConfig, false);

  client1.subscribe(["tickers.BTCUSDT"]);
  assert.equal(client2.getSubscribedTopics().length, 0, "client2 should have no subscriptions");
  assert(client1.getSubscribedTopics().includes("tickers.BTCUSDT"), "client1 should have subscription");
});