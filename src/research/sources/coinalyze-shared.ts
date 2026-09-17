// Shared token-bucket limiter for the Coinalyze API — specs/daily-catalyst-manual-trading.md
// §5.16/§10.2: 40 API calls per minute per API key, and every symbol named in a request's
// comma-separated `symbols` param consumes one of those 40 credits even though the whole request
// is a single HTTP round trip (Coinalyze's own accounting, not ours). This is a small dedicated
// bucket — not src/bybit/rate-limiter.ts's EndpointRateLimiter, which is keyed off Bybit-specific
// per-path budgets in src/bybit/types.ts — so coinalyze-oi.ts's live adapter and
// scripts/backfill-history.ts's coinalyze-oi backfill throttle against the same shared budget
// within a process.

export interface CoinalyzeRateLimiterDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface CoinalyzeRateLimiter {
  /** Waits for one credit, then consumes it. Call once per symbol in a request. */
  acquire(): Promise<void>;
}

const defaultDeps: CoinalyzeRateLimiterDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** capacity/refillPerMinute default to the documented 40 req/min budget; overridable so tests
 *  never sleep in real time. */
export function createCoinalyzeRateLimiter(options: {
  capacity?: number;
  refillPerMinute?: number;
  deps?: CoinalyzeRateLimiterDeps;
} = {}): CoinalyzeRateLimiter {
  const capacity = options.capacity ?? 40;
  const refillPerMs = (options.refillPerMinute ?? 40) / 60_000;
  const deps = options.deps ?? defaultDeps;
  let tokens = capacity;
  let lastRefill = deps.now();

  function refill(): void {
    const now = deps.now();
    const elapsed = now - lastRefill;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
    lastRefill = now;
  }

  return {
    async acquire(): Promise<void> {
      for (;;) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const waitMs = Math.max(1, (1 - tokens) / refillPerMs);
        await deps.sleep(waitMs);
      }
    },
  };
}

const sharedLimiter = createCoinalyzeRateLimiter();

/** One module-level shared instance — one Coinalyze budget per process (same pattern as
 *  src/research/sources/bybit-shared.ts's acquireBybitSlot). */
export async function acquireCoinalyzeSlot(): Promise<void> {
  await sharedLimiter.acquire();
}
