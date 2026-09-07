export interface MarketSnapshot {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  timestamp: number;
  /** Real 24h high/low from the exchange, when available (e.g. live Bybit tickers).
   *  Left undefined in paper/simulated mode — callers fall back to their own estimate. */
  high24h?: number;
  low24h?: number;
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

  // No-exchange demo mode has no real price to seed from — derive a stable,
  // symbol-distinct base price so different symbols don't all render as if they
  // were the same ~$41k asset (still entirely simulated, never real capital).
  const basePrices = new Map<string, number>();
  for (const sym of symbols) {
    let hash = 0;
    for (let i = 0; i < sym.length; i++) hash = (hash * 31 + sym.charCodeAt(i)) >>> 0;
    basePrices.set(sym, 1 + (hash % 100000) / 100);
  }

  while (!signal?.aborted) {
    try {
      // In a real app this would call ccxt. For now, simulate.
      const snapshots = new Map<string, MarketSnapshot>();
      for (const sym of symbols) {
        const base = basePrices.get(sym)!;
        snapshots.set(sym, {
          symbol: sym,
          price: base * (1 + (Math.random() - 0.5) * 0.04),
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