// AC-7, AC-7a — specs/daily-catalyst-manual-trading.md §7.
//
// fetchWithRetryPolicy never rejects, and its 429 policy is: retry once after Retry-After
// seconds when that value is present and <= 60; otherwise give up without retrying.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchWithRetryPolicy } from "../src/research/http.ts";

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    calls.push(ms);
  };
}

test("AC-7: a network error resolves with status unavailable, never rejects", async () => {
  const fetchFn = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  const result = await fetchWithRetryPolicy("https://example.invalid/x", undefined, { fetch: fetchFn, sleep: fakeSleep([]) });
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    assert.match(result.detail, /ECONNREFUSED/);
  }
});

test("AC-7a: 429 with Retry-After:1 twice makes exactly 2 requests and ends unavailable", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return jsonResponse(429, "", { "Retry-After": "1" });
  }) as typeof fetch;
  const sleeps: number[] = [];

  const result = await fetchWithRetryPolicy("https://example.invalid/x", undefined, { fetch: fetchFn, sleep: fakeSleep(sleeps) });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(result.kind, "unavailable");
});

test("AC-7a: 429 then 200 retries once and returns ok", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, "", { "Retry-After": "1" });
    return jsonResponse(200, "hello");
  }) as typeof fetch;

  const result = await fetchWithRetryPolicy("https://example.invalid/x", undefined, { fetch: fetchFn, sleep: fakeSleep([]) });

  assert.equal(calls, 2);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.status, 200);
    assert.equal(result.body, "hello");
  }
});

test("AC-7a: Retry-After 120 exceeds the 60s cap — no retry, unavailable", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return jsonResponse(429, "", { "Retry-After": "120" });
  }) as typeof fetch;

  const result = await fetchWithRetryPolicy("https://example.invalid/x", undefined, { fetch: fetchFn, sleep: fakeSleep([]) });

  assert.equal(calls, 1);
  assert.equal(result.kind, "unavailable");
});

test("fetchWithRetryPolicy: absent Retry-After header also means no retry", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return jsonResponse(429, "");
  }) as typeof fetch;

  const result = await fetchWithRetryPolicy("https://example.invalid/x", undefined, { fetch: fetchFn, sleep: fakeSleep([]) });

  assert.equal(calls, 1);
  assert.equal(result.kind, "unavailable");
});

test("fetchWithRetryPolicy: a non-429 status is passed through as ok", async () => {
  const fetchFn = (async () => jsonResponse(500, "server error")) as typeof fetch;
  const result = await fetchWithRetryPolicy("https://example.invalid/x", undefined, { fetch: fetchFn, sleep: fakeSleep([]) });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.status, 500);
});
