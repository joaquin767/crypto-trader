import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { acquireInstanceLock, lockPath, InstanceLockError } from "../src/instance-lock.ts";

function cleanup(apiKey: string) {
  const path = lockPath(apiKey);
  if (existsSync(path)) unlinkSync(path);
}

/** A PID that's guaranteed to no longer exist: a child process that already exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""]);
  return result.pid!;
}

test("acquireInstanceLock succeeds when no lock exists, and release() removes it", () => {
  const apiKey = `test-key-${Date.now()}-a`;
  cleanup(apiKey);
  try {
    const lock = acquireInstanceLock(apiKey);
    assert(existsSync(lockPath(apiKey)), "lock file should be written");
    lock.release();
    assert(!existsSync(lockPath(apiKey)), "lock file should be removed on release");
  } finally {
    cleanup(apiKey);
  }
});

test("acquireInstanceLock throws when another live process holds the lock for the same key", () => {
  const apiKey = `test-key-${Date.now()}-b`;
  cleanup(apiKey);
  try {
    // Our own PID is guaranteed alive — simulates a genuinely running other instance.
    writeFileSync(lockPath(apiKey), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    assert.throws(() => acquireInstanceLock(apiKey), InstanceLockError);
  } finally {
    cleanup(apiKey);
  }
});

test("acquireInstanceLock reclaims a stale lock (dead PID) instead of refusing to start", () => {
  const apiKey = `test-key-${Date.now()}-c`;
  cleanup(apiKey);
  try {
    writeFileSync(lockPath(apiKey), JSON.stringify({ pid: deadPid(), startedAt: Date.now() - 100000 }));
    const lock = acquireInstanceLock(apiKey); // must not throw
    lock.release();
  } finally {
    cleanup(apiKey);
  }
});

test("acquireInstanceLock reclaims a corrupt/unreadable lock file", () => {
  const apiKey = `test-key-${Date.now()}-d`;
  cleanup(apiKey);
  try {
    writeFileSync(lockPath(apiKey), "not json");
    const lock = acquireInstanceLock(apiKey); // must not throw
    lock.release();
  } finally {
    cleanup(apiKey);
  }
});

test("different API keys get independent locks — no false conflict", () => {
  const keyA = `test-key-${Date.now()}-e1`;
  const keyB = `test-key-${Date.now()}-e2`;
  cleanup(keyA);
  cleanup(keyB);
  try {
    const lockA = acquireInstanceLock(keyA);
    const lockB = acquireInstanceLock(keyB); // must not throw — different key
    lockA.release();
    lockB.release();
  } finally {
    cleanup(keyA);
    cleanup(keyB);
  }
});

test("release() is idempotent", () => {
  const apiKey = `test-key-${Date.now()}-f`;
  cleanup(apiKey);
  try {
    const lock = acquireInstanceLock(apiKey);
    lock.release();
    assert.doesNotThrow(() => lock.release());
  } finally {
    cleanup(apiKey);
  }
});
