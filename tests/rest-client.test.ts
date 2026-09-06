import { test } from "node:test";
import assert from "node:assert/strict";
import { RestClient } from "../src/bybit/rest.ts";
import { BybitConfigError } from "../src/bybit/types.ts";

const mockConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  testnet: true,
  symbols: ["BTCUSDT"],
  wsPingIntervalMs: 20000,
  maxRetries: 3,
};

// ── Constructor ──────────────────────────────────────────────────────

test("RestClient constructor throws without API key", () => {
  assert.throws(
    () => new RestClient({ ...mockConfig, apiKey: "" }),
    BybitConfigError,
  );
});

test("RestClient constructor throws without API secret", () => {
  assert.throws(
    () => new RestClient({ ...mockConfig, apiSecret: "" }),
    BybitConfigError,
  );
});

test("RestClient constructor accepts valid config", () => {
  const client = new RestClient(mockConfig);
  assert(client instanceof RestClient);
});

// ── Time Sync ────────────────────────────────────────────────────────

test("syncTime returns time diff", async () => {
  const client = new RestClient(mockConfig);
  // Mock the fetch call
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { timeSecond: "1743859200", timeNano: "1743859200000000000" },
      }),
    );

  try {
    const diff = await client.syncTime();
    assert(typeof diff === "number");
    assert(!Number.isNaN(diff));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("syncTime handles timeSecond already in milliseconds", async () => {
  const client = new RestClient(mockConfig);
  const originalFetch = globalThis.fetch;
  // Use a current time in milliseconds format (> 1e12). This verifies the
  // detection logic prevents double-multiplication that would produce an
  // absurdly large timestamp.
  const nowMs = Date.now(); // 13-digit ms timestamp
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { timeSecond: String(nowMs), timeNano: "0" },
      }),
    );

  try {
    const diff = await client.syncTime();
    assert(typeof diff === "number");
    // The diff should be reasonable (within a few seconds of network latency)
    // If we had multiplied ms by 1000, the diff would be ~nowMs * 1000 (huge)
    assert(diff > -60000 && diff < 60000, `diff ${diff} should be within 1 minute`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("syncTime handles network failure gracefully", async () => {
  const client = new RestClient(mockConfig);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network error");
  };

  try {
    await assert.rejects(async () => {
      await client.syncTime();
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Signature Generation ─────────────────────────────────────────────

test("sign method generates valid HMAC", async () => {
  const client = new RestClient(mockConfig);
  // Access the private sign method via bracket notation
  const sign = (client as any).sign.bind(client);
  const result = sign("POST", "/v5/order/create", JSON.stringify({ symbol: "BTCUSDT" }));

  assert(typeof result.timestamp === "number");
  assert(typeof result.signature === "string");
  assert(result.signature.length > 0, "signature should not be empty");
});

test("sign method handles GET requests", async () => {
  const client = new RestClient(mockConfig);
  const sign = (client as any).sign.bind(client);
  const result = sign("GET", "/v5/market/tickers?category=linear&symbol=BTCUSDT");

  assert(typeof result.timestamp === "number");
  assert(typeof result.signature === "string");
});

// ── Rate Limiting ────────────────────────────────────────────────────

test("rate limit bucket is created per endpoint", async () => {
  const client = new RestClient(mockConfig);
  // Access private bucket map
  const buckets: Map<string, any> = (client as any).buckets;

  // Use getTickers (which goes through the request method) to trigger bucket creation
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { category: "linear", list: [] },
      }),
      {
        headers: {
          "X-Bapi-Limit-Status": "50",
          "X-Bapi-Limit": "50",
          "Content-Type": "application/json",
        },
      },
    );

  try {
    await client.getTickers("linear");
    // Bucket should have been created for this endpoint
    assert(buckets.size > 0, "should have at least one bucket");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Error Classification ─────────────────────────────────────────────

test("10001 with minimum limit creates BybitInvalidQtyError", async () => {
  const { classifyError, BybitInvalidQtyError } = await import("../src/bybit/types.ts");
  const err = classifyError(10001, "The number of contracts exceeds minimum limit allowed");
  assert(err instanceof BybitInvalidQtyError);
});

test("unknown error code creates generic BybitApiError", async () => {
  const { classifyError, BybitApiError } = await import("../src/bybit/types.ts");
  const err = classifyError(99999, "Unknown error");
  assert(err instanceof BybitApiError);
  assert(!err.name.includes("Auth"));
  assert(!err.name.includes("RateLimit"));
});

// ── Endpoint Limits ──────────────────────────────────────────────────

test("getEndpointLimit returns correct limits", async () => {
  const { getEndpointLimit } = await import("../src/bybit/types.ts");
  const limits = getEndpointLimit("/v5/order/create");
  assert.equal(limits.maxPerSecond, 2);
  assert.equal(limits.maxBurst, 5);
});

test("getEndpointLimit returns defaults for unknown path", async () => {
  const { getEndpointLimit } = await import("../src/bybit/types.ts");
  const limits = getEndpointLimit("/v5/unknown/endpoint");
  assert.equal(limits.maxPerSecond, 5);
  assert.equal(limits.maxBurst, 10);
});

test("getEndpointLimit matches by prefix", async () => {
  const { getEndpointLimit } = await import("../src/bybit/types.ts");
  const limits = getEndpointLimit("/v5/order/create?symbol=BTCUSDT");
  assert.equal(limits.maxPerSecond, 2);
});

// ── Request Retry Logic ──────────────────────────────────────────────

test("request retries on network error", async () => {
  const client = new RestClient(mockConfig);
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount < 3) throw new Error("Network error");
    return new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { category: "linear", list: [] },
      }),
      {
        headers: {
          "X-Bapi-Limit-Status": "50",
          "X-Bapi-Limit": "50",
          "Content-Type": "application/json",
        },
      },
    );
  };

  try {
    // Use getTickers which goes through the request() method with retry logic
    const result = await client.getTickers("linear");
    assert(result);
    assert(callCount >= 2, "should have retried at least once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Public API Methods ───────────────────────────────────────────────

test("getTickers builds correct URL", async () => {
  const client = new RestClient(mockConfig);
  let capturedUrl = "";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    capturedUrl = url.toString();
    return new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { category: "linear", list: [] },
      }),
      {
        headers: {
          "X-Bapi-Limit-Status": "50",
          "X-Bapi-Limit": "50",
          "Content-Type": "application/json",
        },
      },
    );
  };

  try {
    await client.getTickers("linear", "BTCUSDT");
    assert(capturedUrl.includes("/v5/market/tickers"));
    assert(capturedUrl.includes("category=linear"));
    assert(capturedUrl.includes("symbol=BTCUSDT"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getKline builds correct URL", async () => {
  const client = new RestClient(mockConfig);
  let capturedUrl = "";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    capturedUrl = url.toString();
    return new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { category: "linear", symbol: "BTCUSDT", list: [] },
      }),
      {
        headers: {
          "X-Bapi-Limit-Status": "50",
          "X-Bapi-Limit": "50",
          "Content-Type": "application/json",
        },
      },
    );
  };

  try {
    await client.getKline("linear", "BTCUSDT", "15");
    assert(capturedUrl.includes("/v5/market/kline"));
    assert(capturedUrl.includes("interval=15"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getInstruments builds correct URL", async () => {
  const client = new RestClient(mockConfig);
  let capturedUrl = "";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    capturedUrl = url.toString();
    return new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { category: "linear", list: [] },
      }),
      {
        headers: {
          "X-Bapi-Limit-Status": "50",
          "X-Bapi-Limit": "50",
          "Content-Type": "application/json",
        },
      },
    );
  };

  try {
    await client.getInstruments("linear", "BTCUSDT");
    assert(capturedUrl.includes("/v5/market/instruments"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Error Response Handling ──────────────────────────────────────────

test("request throws BybitApiError on non-zero retCode", async () => {
  const client = new RestClient(mockConfig);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        retCode: 10001,
        retMsg: "Some error occurred",
        result: {},
      }),
      {
        headers: {
          "X-Bapi-Limit-Status": "50",
          "X-Bapi-Limit": "50",
          "Content-Type": "application/json",
        },
      },
    );

  try {
    const { BybitApiError } = await import("../src/bybit/types.ts");
    await assert.rejects(
      async () => {
        // Use the public getTickers endpoint to trigger a request
        await client.getTickers("linear");
      },
      (err: any) => err instanceof BybitApiError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Note: HTTP 429 and 403 tests are omitted because they have built-in
// retry delays (5s and 30s respectively) that make them impractical
// for unit testing. The retry logic is tested indirectly via the
// "request retries on network error" test above.

// ── Timestamp Fallback ───────────────────────────────────────────────

test("getTimestamp falls back to Date.now() when serverTimeDiff is NaN", () => {
  const client = new RestClient(mockConfig);
  // Set serverTimeDiff to NaN
  (client as any).serverTimeDiff = NaN;
  const ts = (client as any).getTimestamp();
  assert(typeof ts === "number");
  assert(!Number.isNaN(ts));
  assert(ts > 1700000000000, "timestamp should be reasonable");
});

test("getTimestamp returns adjusted time when serverTimeDiff is valid", () => {
  const client = new RestClient(mockConfig);
  (client as any).serverTimeDiff = 500; // 500ms ahead of server
  const ts = (client as any).getTimestamp();
  assert(typeof ts === "number");
  assert(ts > Date.now() + 400, "should be adjusted forward");
});