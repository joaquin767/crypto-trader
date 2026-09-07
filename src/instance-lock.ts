// Duplicate-instance protection — see specs/live-trading-readiness.md §7.3 (F6).
//
// Nothing previously stopped the same API key being started by two separate
// processes at once (this happened by accident in this very session — a
// leftover background dev server was still running when a second instance
// was started). Two unsynchronized local portfolios trading against one real
// account is a direct path to uncontrolled, doubled risk exposure and an
// unreconcilable journal. The lock is keyed by a hash of the API key (never
// the raw key) and lives in the OS temp directory so it applies regardless of
// which directory/config path the process was started from.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class InstanceLockError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InstanceLockError";
  }
}

interface LockFile {
  pid: number;
  startedAt: number;
}

/** Exposed for tests only — deterministic path for a given API key's lock file. */
export function lockPath(apiKey: string): string {
  const hash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return join(tmpdir(), `crypto-trader-${hash}.lock`);
}

/** True if a process with this PID is currently running. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing — it only checks whether the process exists and
    // is signalable. Throws ESRCH (no such process) or EPERM otherwise.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, different owner
  }
}

/**
 * Acquire the single-instance lock for this API key. Throws InstanceLockError
 * if another live process already holds it. A stale lock (the recorded PID is
 * no longer running) is detected and reclaimed automatically.
 *
 * Call this once, as early as possible in startup — before connecting to any
 * exchange or placing any order — and call the returned `release()` on clean
 * shutdown.
 */
export function acquireInstanceLock(apiKey: string): { release: () => void } {
  const path = lockPath(apiKey);

  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf-8")) as LockFile;
      if (isProcessAlive(existing.pid)) {
        throw new InstanceLockError(
          `Another crypto-trader instance (PID ${existing.pid}, started ` +
          `${new Date(existing.startedAt).toISOString()}) is already running with this ` +
          `API key. Two instances trading the same account simultaneously can double risk ` +
          `exposure and desync the local journal — stop the other instance first ` +
          `(or if you're certain it's not actually running, delete ${path}).`,
        );
      }
      // Stale lock — the process that held it is gone. Reclaim it.
    } catch (err) {
      if (err instanceof InstanceLockError) throw err;
      // Corrupt/unreadable lock file — treat as stale and reclaim rather than
      // refuse to start over a file we can't even interpret.
    }
  }

  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockFile));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only remove it if it's still ours — a fresher instance may have
      // already reclaimed this path if we're releasing late during a
      // stale-lock race; never delete someone else's live lock.
      const current = JSON.parse(readFileSync(path, "utf-8")) as LockFile;
      if (current.pid === process.pid) unlinkSync(path);
    } catch {
      // Already gone or unreadable — nothing to clean up.
    }
  };

  // Belt-and-suspenders: this app has no SIGINT/SIGTERM handling today, so a
  // Ctrl+C exit never reaches an explicit release() call in main.ts's normal
  // cleanup path. The lock is already self-healing regardless (a dead PID is
  // detected and reclaimed on next start), but releasing promptly on the
  // 'exit' event — which Node still emits for the default signal-triggered
  // termination path — avoids leaving a stale-but-technically-valid-looking
  // lock file sitting around between runs.
  process.once("exit", release);

  return { release };
}
