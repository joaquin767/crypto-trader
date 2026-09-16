// Shared HTTP helper for research source adapters — specs/daily-catalyst-manual-trading.md §7/AC-7a.
//
// Every adapter fetch goes through here so the timeout and 429 policy are enforced in one
// place: a 10s per-request timeout (AbortController) and "one retry after Retry-After
// seconds when <= 60, no retry when > 60 or absent". Adapters never see a rejected promise —
// network errors and exhausted retries both resolve to { kind: "unavailable" }.

import { existsSync, readFileSync, statSync } from "node:fs";

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RETRY_AFTER_S = 60;

export type HttpFetchResult =
  | { kind: "ok"; status: number; body: string }
  | { kind: "unavailable"; detail: string };

/** Dependencies every source adapter factory accepts, so tests never touch the network,
 *  the clock, or a real timer. */
export interface AdapterDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  readFile: (path: string) => string;
  /** mtime in epoch ms of a file; used by the Farside CSV fallback (availableAt = file mtime). */
  statMtimeMs: (path: string) => number;
  fileExists: (path: string) => boolean;
}

export function defaultAdapterDeps(): AdapterDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readFile: (path) => readFileSync(path, "utf-8"),
    statMtimeMs: (path) => statSync(path).mtimeMs,
    fileExists: (path) => existsSync(path),
  };
}

async function attemptOnce(
  url: string,
  init: RequestInit | undefined,
  deps: Pick<AdapterDeps, "fetch">,
): Promise<{ kind: "ok"; response: Response } | { kind: "unavailable"; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, { ...init, signal: controller.signal });
    return { kind: "ok", response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "unavailable", detail: `network error fetching ${url}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with a 10s timeout and the 429 retry policy: on HTTP 429, retry once after
 * `Retry-After` seconds if that value is present and <= 60; otherwise (absent, unparseable,
 * or > 60) give up immediately without retrying. Never rejects.
 */
export async function fetchWithRetryPolicy(
  url: string,
  init: RequestInit | undefined,
  deps: Pick<AdapterDeps, "fetch" | "sleep">,
): Promise<HttpFetchResult> {
  const first = await attemptOnce(url, init, deps);
  if (first.kind === "unavailable") return first;

  if (first.response.status === 429) {
    const retryAfterHeader = first.response.headers.get("retry-after");
    const retryAfterS = retryAfterHeader === null ? Number.NaN : Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(retryAfterS) && retryAfterS >= 0 && retryAfterS <= MAX_RETRY_AFTER_S) {
      await deps.sleep(retryAfterS * 1000);
      const second = await attemptOnce(url, init, deps);
      if (second.kind === "unavailable") return second;
      if (second.response.status === 429) {
        return { kind: "unavailable", detail: `rate limited (429) again after retrying ${url}` };
      }
      return { kind: "ok", status: second.response.status, body: await second.response.text() };
    }
    return {
      kind: "unavailable",
      detail: `rate limited (429) fetching ${url}; Retry-After "${retryAfterHeader ?? "absent"}" exceeds the ${MAX_RETRY_AFTER_S}s cap or is unusable`,
    };
  }

  return { kind: "ok", status: first.response.status, body: await first.response.text() };
}
