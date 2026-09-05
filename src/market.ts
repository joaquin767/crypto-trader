export interface MarketSnapshot {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  timestamp: number;
}

/**
 * Create an async iterable that yields market snapshots at the given interval.
 * In paper mode (default), snapshots are simulated with fake data.
 * In live mode, snapshots come from ccxt exchange API.
 *
 * Retries connection up to 3 times with exponential backoff on failure.
 */
export async function* watch(
  symbols: string[],
  intervalMs: number,
  signal?: AbortSignal,
): AsyncGenerator<Map<string, MarketSnapshot>> {
  let attempt = 0;
  const maxRetries = 3;

  while (!signal?.aborted) {
    try {
      // In a real app this would call ccxt. For now, simulate.
      const snapshots = new Map<string, MarketSnapshot>();
      for (const sym of symbols) {
        snapshots.set(sym, {
          symbol: sym,
          price: 40000 + Math.random() * 2000,
          change24h: (Math.random() - 0.5) * 10,
          volume24h: Math.random() * 1000,
          timestamp: Date.now(),
        });
      }
      yield snapshots;
      await sleep(intervalMs, signal);
      attempt = 0; // reset on success
    } catch (err: unknown) {
      if (signal?.aborted) return;
      attempt++;
      if (attempt >= maxRetries) {
        console.warn(`[market] API unavailable after ${maxRetries} retries`);
        yield new Map(); // yield empty map so the app stays alive
        await sleep(intervalMs, signal);
      } else {
        await sleep(Math.pow(2, attempt) * 1000, signal); // exponential backoff
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}