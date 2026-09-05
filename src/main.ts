import { loadConfig, type Config } from "./config.ts";
import { watch, type MarketSnapshot } from "./market.ts";
import { evaluate, type TradeSignal } from "./risk.ts";
import { empty, update, type Portfolio } from "./portfolio.ts";
import { execute, type TradeResult } from "./executor.ts";
import { render, type AppState } from "./tui.ts";

export { loadConfig, type Config };
export { type MarketSnapshot };
export { evaluate, type TradeSignal };
export { empty, update, type Portfolio };
export { execute, type TradeResult };
export { render, type AppState };

/** CLI argument parser. */
function parseArgs(argv: string[]): { configPath?: string; live: boolean } {
  const args = { configPath: undefined as string | undefined, live: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) args.configPath = argv[++i]!;
    if (argv[i] === "--live") args.live = true;
  }
  return args;
}

/**
 * Bootstrap and run the crypto-trader app.
 * Loads config, starts market watcher, evaluates risk, executes trades,
 * updates portfolio, and renders the TUI — all in a loop.
 *
 * Pass an AbortSignal to stop the loop (e.g. in tests).
 */
export async function start(config: Config, signal?: AbortSignal): Promise<void> {
  const mode = process.argv.includes("--live") ? "live" : "paper";
  let portfolio: Portfolio = empty();
  let lastSignal: TradeSignal | null = null;
  let statusMessage = "starting...";

  const state: AppState = {
    marketData: new Map(),
    portfolio,
    lastSignal,
    statusMessage,
    mode,
  };

  // Initial render
  render(state);

  for await (const snapshots of watch(config.symbols, config.refreshIntervalMs, signal)) {
    state.marketData = snapshots;

    // Evaluate each symbol
    for (const [symbol, snapshot] of snapshots) {
      const signal = evaluate(snapshot, portfolio, config);
      lastSignal = signal;

      if (signal.type !== "hold") {
        // Check daily trade limit before executing
        if (config.maxDailyTrades > 0 && portfolio.dailyTradeCount >= config.maxDailyTrades) {
          statusMessage = `daily trade limit reached (${config.maxDailyTrades})`;
          continue;
        }

        const trade: TradeResult = await execute(signal, config);
        portfolio = update(portfolio, trade);
        statusMessage = `${mode.toUpperCase()} | ${trade.side} ${trade.symbol} @ $${trade.price.toFixed(2)}`;
      } else {
        statusMessage = `${mode.toUpperCase()} | ${signal.reason}`;
      }
    }

    state.portfolio = portfolio;
    state.lastSignal = lastSignal;
    state.statusMessage = statusMessage;
    render(state);
  }
}

// CLI entry point when run directly
const cliArgs = parseArgs(process.argv.slice(2));
if (cliArgs.configPath) {
  try {
    const config = loadConfig(cliArgs.configPath);
    start(config).catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.error("Usage: node src/main.ts --config ./config.json [--live]");
  process.exit(1);
}