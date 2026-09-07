// Per-endpoint token bucket rate limiter for the Bybit REST client.
//
// Bybit bans IPs/API keys that exceed its documented rate limits (see
// docs/bybit-integration spec §9 "Anti-Ban Policy" — HTTP 403 for IP bans,
// retCode 10006 for endpoint-level limits, 10008/10027 for account bans).
// ENDPOINT_LIMITS in types.ts already encodes our conservative (50%-of-official)
// budget per endpoint; this module is what actually enforces it, queuing
// requests instead of rejecting them.

import { getEndpointLimit } from "./types.ts";

interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefill: number;
  /** Set when Bybit itself reports retCode 10006 for this endpoint — hard pause. */
  cooldownUntil: number;
}

export class EndpointRateLimiter {
  private buckets = new Map<string, Bucket>();

  private getBucket(path: string): Bucket {
    let bucket = this.buckets.get(path);
    if (!bucket) {
      const { maxPerSecond, maxBurst } = getEndpointLimit(path);
      bucket = {
        tokens: maxBurst,
        capacity: maxBurst,
        refillPerMs: maxPerSecond / 1000,
        lastRefill: Date.now(),
        cooldownUntil: 0,
      };
      this.buckets.set(path, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.lastRefill = now;
  }

  /** Wait until a token is available for this endpoint, then consume it. */
  async acquire(path: string): Promise<void> {
    const bucket = this.getBucket(path);
    for (;;) {
      const now = Date.now();
      if (bucket.cooldownUntil > now) {
        await sleep(bucket.cooldownUntil - now);
        continue;
      }
      this.refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const waitMs = Math.max(10, (1 - bucket.tokens) / bucket.refillPerMs);
      await sleep(waitMs);
    }
  }

  /**
   * Called when Bybit itself reports retCode 10006 for this endpoint.
   * Per spec §9B: "increase the safety margin ... wait before sending more requests."
   */
  reportRateLimited(path: string, cooldownMs = 2000): void {
    const bucket = this.getBucket(path);
    bucket.tokens = 0;
    bucket.cooldownUntil = Date.now() + cooldownMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
