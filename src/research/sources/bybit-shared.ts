// Shared throttle for Bybit public market-data endpoints used by research adapters.
//
// Reuses the existing per-endpoint token bucket (src/bybit/rate-limiter.ts) rather than a
// bespoke limiter — its default bucket (5 req/s, burst 10, from getEndpointLimit's fallback
// in src/bybit/types.ts) already sits comfortably under the "<=10 req/s" ceiling this spec
// asks for on public endpoints, and it's shared as one module-level instance so every
// research adapter throttles against the same budget per path.

import { EndpointRateLimiter } from "../../bybit/rate-limiter.ts";

const bybitPublicLimiter = new EndpointRateLimiter();

export async function acquireBybitSlot(path: string): Promise<void> {
  await bybitPublicLimiter.acquire(path);
}
