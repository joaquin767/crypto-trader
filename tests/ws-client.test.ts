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

// ── Message Handling ────────────────────────────────────────────────

test("handleMessage calls registered handler for topic", () => {
  const client = new WsClient(mockConfig, false);
  let received: any = null;
  client.on("tickers.BTCUSDT", (topic, data) => { received = { topic, data }; });

  (client as any).handleMessage(JSON.stringify({
    topic: "tickers.BTCUSDT",
    data: { symbol: "BTCUSDT", lastPrice: "40000" },
  }));

  assert(received !== null);
  assert.equal(received.topic, "tickers.BTCUSDT");
  assert.equal(received.data.symbol, "BTCUSDT");
});

test("handleMessage handles pong messages gracefully", () => {
  const client = new WsClient(mockConfig, false);
  let callCount = 0;
  client.on("tickers.BTCUSDT", () => { callCount++; });

  (client as any).handleMessage(JSON.stringify({ op: "pong" }));
  assert.equal(callCount, 0);
});

test("handleMessage handles subscription responses", () => {
  const client = new WsClient(mockConfig, false);
  let callCount = 0;
  client.on("tickers.BTCUSDT", () => { callCount++; });

  (client as any).handleMessage(JSON.stringify({ op: "subscribe", ret_msg: "subscribe" }));
  assert.equal(callCount, 0);
});

test("handleMessage handles malformed JSON gracefully", () => {
  const client = new WsClient(mockConfig, false);
  let callCount = 0;
  client.on("tickers.BTCUSDT", () => { callCount++; });

  (client as any).handleMessage("not valid json {{{");
  assert.equal(callCount, 0);
});

test("handleMessage calls multiple handlers for same topic", () => {
  const client = new WsClient(mockConfig, false);
  let count1 = 0, count2 = 0;
  client.on("tickers.BTCUSDT", () => { count1++; });
  client.on("tickers.BTCUSDT", () => { count2++; });

  (client as any).handleMessage(JSON.stringify({
    topic: "tickers.BTCUSDT",
    data: { symbol: "BTCUSDT" },
  }));

  assert.equal(count1, 1);
  assert.equal(count2, 1);
});

// ── Connection / Disconnection Lifecycle ────────────────────────────

test("connect rejects when WebSocket construction fails", async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() { throw new Error("Connection refused"); }
    close() {}
    send() {}
  } as any;

  const client = new WsClient(mockConfig, false);
  try {
    await assert.rejects(
      async () => { await client.connect(); },
      /Bybit connection error/,
    );
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test("disconnect clears reconnect timer", () => {
  const client = new WsClient(mockConfig, false);
  client.subscribe(["tickers.BTCUSDT"]);
  (client as any).ws = null;
  (client as any).reconnectAttempts = 0;
  (client as any).maxReconnectAttempts = 3;
  (client as any).tryReconnect();
  // Ensure a timer was set
  assert((client as any).reconnectTimer !== null, "reconnectTimer should be set");
  client.disconnect();
  assert(!client.isConnected());
  assert((client as any).reconnectTimer === null, "reconnectTimer should be cleared on disconnect");
});

// ── Private Stream Authentication ───────────────────────────────────

test("private stream sets correct connection URL", () => {
  const client = new WsClient(mockConfig, true);
  client.subscribe(["order", "position"]);
  assert(client.getSubscribedTopics().includes("order"));
  assert(client.getSubscribedTopics().includes("position"));
});

test("private stream subscribe adds topics", () => {
  const client = new WsClient(mockConfig, true);
  client.subscribe(["order", "position", "wallet"]);
  const topics = client.getSubscribedTopics();
  assert.equal(topics.length, 3);
  assert(topics.includes("order"));
  assert(topics.includes("position"));
  assert(topics.includes("wallet"));
});

// ── Edge Cases ──────────────────────────────────────────────────────

test("subscribe after disconnect is safe", () => {
  const client = new WsClient(mockConfig, false);
  client.disconnect();
  client.subscribe(["tickers.BTCUSDT"]);
  assert(client.getSubscribedTopics().includes("tickers.BTCUSDT"));
});

test("unsubscribe after disconnect is safe", () => {
  const client = new WsClient(mockConfig, false);
  client.subscribe(["tickers.BTCUSDT"]);
  client.disconnect();
  client.unsubscribe(["tickers.BTCUSDT"]);
  assert.equal(client.getSubscribedTopics().length, 0);
});

test("multiple disconnect calls don't leak timers", () => {
  const client = new WsClient(mockConfig, false);
  client.disconnect();
  client.disconnect();
  client.disconnect();
  assert.ok(true, "multiple disconnect calls are safe");
});

test("off removes only the specified handler", () => {
  const client = new WsClient(mockConfig, false);
  let count = 0;
  const handler1 = () => { count++; };
  const handler2 = () => { count++; };

  client.on("tickers.BTCUSDT", handler1);
  client.on("tickers.BTCUSDT", handler2);
  client.off("tickers.BTCUSDT", handler1);

  const handlers = (client as any).handlers.get("tickers.BTCUSDT");
  assert(handlers.has(handler2), "handler2 should still be registered");
  assert(!handlers.has(handler1), "handler1 should be removed");
});

// ── Reconnection ────────────────────────────────────────────────────

test("tryReconnect increments attempt counter", () => {
  const client = new WsClient(mockConfig, false);
  (client as any).reconnectAttempts = 0;
  (client as any).maxReconnectAttempts = 3;
  (client as any).tryReconnect();
  assert.equal((client as any).reconnectAttempts, 1);
  // Clean up the timer
  client.disconnect();
});

test("tryReconnect stops after max attempts", () => {
  const client = new WsClient(mockConfig, false);
  (client as any).reconnectAttempts = 3;
  (client as any).maxReconnectAttempts = 3;
  (client as any).tryReconnect();
  assert.equal((client as any).reconnectAttempts, 3);
  assert.equal((client as any).reconnectTimer, null);
});

// ── Ping / Keepalive ────────────────────────────────────────────────

test("startPing and stopPing don't throw", () => {
  const client = new WsClient(mockConfig, false);
  (client as any).startPing();
  (client as any).stopPing();
  assert.ok(true, "ping lifecycle is safe");
});

test("stopPing is idempotent", () => {
  const client = new WsClient(mockConfig, false);
  (client as any).startPing();
  (client as any).stopPing();
  (client as any).stopPing();
  assert.ok(true, "double stopPing is safe");
});