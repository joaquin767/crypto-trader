import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshPendingOrdersModule() {
  return import(`../src/bybit/pending-orders.ts?t=${Date.now()}-${Math.random()}`);
}

function withTempCwd(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "pending-orders-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  return Promise.resolve(fn(dir)).finally(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });
}

test("recordPendingOrder persists and getPendingOrders reads it back", () => withTempCwd(async (dir) => {
  const mod = await freshPendingOrdersModule();
  mod.recordPendingOrder({ orderLinkId: "abc-123", symbol: "BTCUSDT", intent: "buy", expectedQty: 0.01, timestamp: 1000 });
  const pending = mod.getPendingOrders();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].orderLinkId, "abc-123");
  assert(existsSync(join(dir, "pending-orders.json")));
}));

test("clearPendingOrder removes only the matching order, leaving others intact", () => withTempCwd(async () => {
  const mod = await freshPendingOrdersModule();
  mod.recordPendingOrder({ orderLinkId: "a", symbol: "BTCUSDT", intent: "buy", expectedQty: 0.01, timestamp: 1 });
  mod.recordPendingOrder({ orderLinkId: "b", symbol: "ETHUSDT", intent: "sell", expectedQty: 0.5, timestamp: 2 });
  mod.clearPendingOrder("a");
  const pending = mod.getPendingOrders();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].orderLinkId, "b");
}));

test("clearPendingOrder removes the file entirely once no pending orders remain", () => withTempCwd(async (dir) => {
  const mod = await freshPendingOrdersModule();
  mod.recordPendingOrder({ orderLinkId: "a", symbol: "BTCUSDT", intent: "buy", expectedQty: 0.01, timestamp: 1 });
  mod.clearPendingOrder("a");
  assert.equal(mod.getPendingOrders().length, 0);
  assert(!existsSync(join(dir, "pending-orders.json")), "the file should be cleaned up, not left as an empty array forever");
}));

test("clearPendingOrder on an unknown orderLinkId is a safe no-op", () => withTempCwd(async () => {
  const mod = await freshPendingOrdersModule();
  mod.recordPendingOrder({ orderLinkId: "a", symbol: "BTCUSDT", intent: "buy", expectedQty: 0.01, timestamp: 1 });
  assert.doesNotThrow(() => mod.clearPendingOrder("does-not-exist"));
  assert.equal(mod.getPendingOrders().length, 1);
}));

test("getPendingOrders returns an empty array (not an error) when no file exists yet", () => withTempCwd(async () => {
  const mod = await freshPendingOrdersModule();
  assert.deepEqual(mod.getPendingOrders(), []);
}));

test("a fresh module instance sees pending orders written by a previous instance (simulates a restart)", () => withTempCwd(async () => {
  const mod1 = await freshPendingOrdersModule();
  mod1.recordPendingOrder({ orderLinkId: "crash-me", symbol: "SOLUSDT", intent: "buy", expectedQty: 1.5, timestamp: 5000 });

  const mod2 = await freshPendingOrdersModule(); // simulates the process restarting after a crash
  const pending = mod2.getPendingOrders();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].orderLinkId, "crash-me");
}));
