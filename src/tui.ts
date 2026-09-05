import type { MarketSnapshot } from "./market.ts";
import type { Portfolio } from "./portfolio.ts";
import type { TradeSignal } from "./risk.ts";

export interface AppState {
  marketData: Map<string, MarketSnapshot>;
  portfolio: Portfolio;
  lastSignal: TradeSignal | null;
  statusMessage: string;
  mode: "paper" | "live";
}

/**
 * Render the terminal dashboard using blessed/blessed-contrib.
 * Shows:
 * - Current prices for all watched symbols (green/yellow/red based on change)
 * - Portfolio value and cash
 * - Latest trade signal
 * - Status bar
 *
 * In test/headless environments, just logs to console.
 */
export function render(state: AppState): void {
  // Clear terminal and print a simple dashboard
  console.clear();

  const header = `=== CRYPTO TRADER [${state.mode.toUpperCase()}] ===`;
  console.log(header);
  console.log("=".repeat(header.length));
  console.log();

  // Market data
  console.log("MARKET DATA:");
  for (const [symbol, snap] of state.marketData) {
    const changeColor = snap.change24h > 0 ? "↑" : snap.change24h < 0 ? "↓" : "→";
    const color = snap.change24h > 2 ? "GREEN" : snap.change24h < -2 ? "RED" : "YELLOW";
    console.log(
      `  ${symbol}: $${snap.price.toFixed(2)}  ${changeColor} ${snap.change24h.toFixed(2)}% [${color}]`,
    );
  }
  console.log();

  // Portfolio
  console.log("PORTFOLIO:");
  console.log(`  Total value: $${state.portfolio.totalValueUsd.toFixed(2)}`);
  console.log(`  Cash: $${state.portfolio.cashUsd.toFixed(2)}`);
  console.log(`  Positions: ${state.portfolio.positions.length}`);
  console.log(`  Daily trades: ${state.portfolio.dailyTradeCount}`);
  console.log();

  // Last signal
  if (state.lastSignal) {
    const signalColor =
      state.lastSignal.type === "buy" ? "GREEN" :
      state.lastSignal.type === "sell" ? "RED" : "YELLOW";
    console.log(`LATEST SIGNAL [${signalColor}]:`);
    console.log(`  ${state.lastSignal.type.toUpperCase()} ${state.lastSignal.symbol}`);
    console.log(`  Confidence: ${(state.lastSignal.confidence * 100).toFixed(0)}%`);
    console.log(`  Reason: ${state.lastSignal.reason}`);
    console.log();
  }

  // Status
  console.log(`STATUS: ${state.statusMessage}`);
  console.log("[Press q to quit]");
}