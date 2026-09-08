// Web server with SSE real-time streaming for the dashboard.

import type { MarketSnapshot } from "../market.ts";
import type { Portfolio } from "../portfolio.ts";
import type { TradeSignal } from "../strategy/signals.ts";
import type { TradeRecord } from "../learning/journal.ts";
import type { PerformanceReport } from "../learning/analyzer.ts";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// SSE client tracking — each client gets a [writer, cleanup] pair
const sseClients = new Set<{ write: (data: string) => void; cleanup: () => void }>();

/** Broadcast a JSON payload to all connected SSE clients. */
export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { client.cleanup(); sseClients.delete(client); }
  }
}

/** Get number of connected SSE clients. */
export function clientCount(): number {
  return sseClients.size;
}

export interface DashboardState {
  marketData: Map<string, MarketSnapshot>;
  portfolio: Portfolio;
  lastSignal: TradeSignal | null;
  statusMessage: string;
  mode: "paper" | "live" | "testnet";
  tradeHistory: TradeRecord[];
  performanceReport: PerformanceReport | null;
  bybitConnected?: boolean;         // 🔌 Bybit WebSocket connection status
  bybitLatencyMs?: number;          // ⏱ Bybit WebSocket latency
  bybitMode?: "paper" | "testnet" | "live";  // 🏷 Current bybit mode
  bybitError?: string | null;       // ❌ Last bybit error
  operatingCapitalUsd: number;      // 🔒 User-defined operating capital
  walletTotalUsd?: number;          // 💰 Total wallet balance (display only)
  deploymentRatio: number;          // 📊 How much of operating capital is deployed (0-1)
  // 💸 Cumulative perpetual funding P&L since this session started (spec §3.3).
  // Deliberately kept separate from portfolio/performanceReport — the sign
  // convention isn't yet verified against a live Bybit response, so it's
  // shown as informational rather than blended into trade-based P&L that
  // decisions get made from.
  fundingPnlUsd?: number;
  // 🔴 Portfolio-wide circuit breaker state (spec §5) — distinct from
  // bybitConnected/fatalHalt. null/undefined = not tripped. New entries are
  // halted for every symbol while set; closes are never affected. Only
  // cleared by a restart (see spec §13.3) — never auto-clears.
  circuitBreakerTripped?: { trigger: string; at: number; details: string } | null;
  // ⚠️ Sustained gap between Bybit's real available balance and what the bot
  // believes its cash is (spec §8.3) — informational only, never changes
  // cashUsd. null/undefined = no shortfall detected.
  walletShortfallWarning?: string | null;
  // 🔍 The most recent decision per symbol, so the dashboard can show WHY
  // the bot is or isn't trading each one. With entries now behind several
  // independent gates (signal confirmation, cost-vs-fee, min-hold, the
  // optional model), "no trades" is ambiguous without this — it could be
  // no signal, or a signal that four different gates each declined.
  signalsBySymbol?: Record<string, { type: string; confidence: number; reason: string; at: number }>;
  // ⛔ Symbols whose ENTRIES are halted after a real exchange rejection
  // (closes always stay active — see live-trading-readiness.md §6.2).
  haltedSymbols?: { symbol: string; reason: string; active: boolean }[];
  // 📐 The configured stop-loss / take-profit percentages, so the dashboard
  // can draw a position's real distance-to-stop rather than assuming
  // defaults that may not match this config.
  slPercent?: number;
  tpPercent?: number;
  // 🧠 The trained entry model actually in force, if any — threshold, the
  // held-out AUC it was measured at, and the barriers/horizon it was
  // trained to predict. Surfaced so the dashboard states what genuinely
  // drives entries, rather than parameters nothing reads.
  model?: { enabled: boolean; minProbability: number; testAuc: number; horizonBars: number; interval: string; tp: number; sl: number } | null;
}

/**
 * Create and start a Hono web server on the given port.
 * Returns a { close } handle.
 */
export async function createServer(
  state: DashboardState,
  port: number,
): Promise<{ close: () => Promise<void> }> {
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");

  const app = new Hono();

  // Serve dashboard HTML at /
  app.get("/", (c) => {
    const htmlPath = join(dirname(new URL(import.meta.url).pathname), "public", "index.html");
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, "utf-8");
      return c.html(html);
    }
    return c.text("Dashboard not found", 404);
  });

  // SSE stream for real-time data
  app.get("/events", (c) => {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Send initial state
    const initPayload = `event: init\ndata: ${JSON.stringify(serializeState(state))}\n\n`;
    writer.write(encoder.encode(initPayload)).catch(() => {});

    const client = {
      write: (data: string) => {
        writer.write(encoder.encode(data)).catch(() => {});
      },
      cleanup: () => {
        writer.close().catch(() => {});
      },
    };
    sseClients.add(client);

    // Keepalive every 30s
    const keepAlive = setInterval(() => {
      writer.write(encoder.encode(": keepalive\n\n")).catch(() => {});
    }, 30000);

    // Remove on disconnect
    c.req.raw.signal?.addEventListener("abort", () => {
      sseClients.delete(client);
      clearInterval(keepAlive);
      writer.close().catch(() => {});
    }, { once: true });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // REST API endpoints
  app.get("/api/state", (c) => c.json(serializeState(state)));
  app.get("/api/history", (c) => c.json(state.tradeHistory));

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`[server] Dashboard at http://localhost:${port}`);
      resolve({
        close: async () => {
          server.close();
          for (const client of sseClients) {
            client.cleanup();
          }
          sseClients.clear();
        },
      });
    });
  });
}

function serializeState(state: DashboardState) {
  return {
    marketData: Object.fromEntries(state.marketData),
    portfolio: state.portfolio,
    lastSignal: state.lastSignal,
    statusMessage: state.statusMessage,
    mode: state.mode,
    tradeHistory: state.tradeHistory.slice(-50),
    performanceReport: state.performanceReport,
    bybitConnected: state.bybitConnected,
    bybitLatencyMs: state.bybitLatencyMs,
    bybitMode: state.bybitMode,
    bybitError: state.bybitError,
    operatingCapitalUsd: state.operatingCapitalUsd,
    walletTotalUsd: state.walletTotalUsd,
    deploymentRatio: state.deploymentRatio,
    fundingPnlUsd: state.fundingPnlUsd,
    circuitBreakerTripped: state.circuitBreakerTripped,
    walletShortfallWarning: state.walletShortfallWarning,
    signalsBySymbol: state.signalsBySymbol,
    haltedSymbols: state.haltedSymbols,
    slPercent: state.slPercent,
    tpPercent: state.tpPercent,
    model: state.model,
  };
}