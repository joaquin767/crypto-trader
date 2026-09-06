import { loadConfig, type Config } from "./config.ts";
import { watch, type MarketSnapshot } from "./market.ts";
import { analyze, type TradeSignal, clearHistory } from "./strategy/signals.ts";
import { calcPositionSize } from "./strategy/risk.ts";
import { create, update, canAfford, deploymentRatio, type Portfolio } from "./portfolio.ts";
import { execute, type TradeResult } from "./executor.ts";
import { render, type AppState } from "./tui.ts";
import { recordEntry, recordExit, getClosedTrades, getHistory, clearJournal, type TradeRecord } from "./learning/journal.ts";
import { analyze as analyzePerformance, type PerformanceReport } from "./learning/analyzer.ts";
import { defaultParams, optimize, getInsights, type StrategyParams, type LearningInsight } from "./learning/optimizer.ts";
import { createServer, broadcast, type DashboardState } from "./server/index.ts";
import { BybitConnector, type BybitConnectorState } from "./bybit/connector.ts";
import { appSymbolToBybit } from "./bybit/adapters.ts";
import type { BybitConfig } from "./bybit/types.ts";

export { loadConfig, type Config };
export { type MarketSnapshot };
export { analyze, type TradeSignal, getHistory as getSignalHistory } from "./strategy/signals.ts";
export { type TradeRecord, getHistory as getJournalHistory } from "./learning/journal.ts";
export { BybitConnector };

/** CLI argument parser. */
function parseArgs(argv: string[]): { configPath?: string; live: boolean; port: number } {
  const args = { configPath: undefined as string | undefined, live: false, port: 3081 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) args.configPath = argv[++i]!;
    if (argv[i] === "--live") args.live = true;
    if (argv[i] === "--port" && argv[i + 1]) args.port = parseInt(argv[++i]!);
  }
  return args;
}

/**
 * Bootstrap and run the expert crypto-trader with web dashboard.
 *
 * Architecture:
 * - WebSocket feeds real-time tickers → dashboard display (50-100ms updates)
 * - A timer loop (every refreshIntervalMs) evaluates signals and executes trades
 * - REST API handles order placement (reliable ack)
 */
export async function start(config: Config, signal?: AbortSignal): Promise<void> {
  const mode = (process.argv.includes("--live") ? "live" : "paper") as "paper" | "live" | "testnet";
  const port = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? "3081");
  const useBybit = config.exchange.toLowerCase() === "bybit";

  let portfolio: Portfolio = create(config.maxCapitalUsd);
  let lastSignal: TradeSignal | null = null;
  let statusMessage = "starting...";
  let strategyParams: StrategyParams = defaultParams();
  let performanceReport: PerformanceReport | null = null;
  const learningInsights: LearningInsight[] = [];

  // Shared market data (updated by WebSocket or simulated watch)
  let latestMarketData = new Map<string, MarketSnapshot>();

  // Learning timer
  let lastLearningRound = Date.now();
  const learningInterval = 30000;

  // Dashboard state
  const dashboardState: DashboardState = {
    marketData: new Map(),
    portfolio,
    lastSignal: null,
    statusMessage,
    mode,
    tradeHistory: [],
    performanceReport: null,
    learningInsights: [],
    strategyParams,
    bybitConnected: false,
    bybitLatencyMs: 0,
    bybitMode: "paper",
    bybitError: null,
    operatingCapitalUsd: config.maxCapitalUsd,
    walletTotalUsd: config.maxCapitalUsd,
    deploymentRatio: 0,
  };

  // Start the web server
  const server = await createServer(dashboardState, port);
  console.log(`[crypto-trader] Dashboard: http://localhost:${port}`);
  console.log(`[crypto-trader] Mode: ${mode.toUpperCase()}`);
  if (useBybit) console.log("[crypto-trader] Exchange: BYBIT (WebSocket tickers + REST orders)");

  // Initial render
  const appState: AppState = {
    marketData: new Map(),
    portfolio,
    lastSignal: null,
    statusMessage,
    mode,
  };
  render(appState);

  const initialCash = portfolio.cashUsd;

  // ── Shared trading cycle ───────────────────────────────────────────
  // This function runs every refreshIntervalMs to evaluate signals and trade.
  // It uses the latest market data regardless of source (Bybit or simulated).
  async function runTradingCycle(): Promise<void> {
    if (latestMarketData.size === 0) return;

    for (const [symbol, snapshot] of latestMarketData) {
      if (config.maxDailyTrades > 0 && portfolio.dailyTradeCount >= config.maxDailyTrades) {
        statusMessage = `daily trade limit reached (${config.maxDailyTrades})`;
        continue;
      }

      const tradeSignal = analyze(snapshot, portfolio, config);
      lastSignal = tradeSignal;

      if (tradeSignal.type === "buy" || tradeSignal.type === "sell") {
        const positionUsd = calcPositionSize(tradeSignal.confidence, portfolio, config);

        if (positionUsd <= 0) {
          statusMessage = `${mode.toUpperCase()} | insufficient cash for ${tradeSignal.symbol}`;
          continue;
        }

        let result: TradeResult;

        if (useBybit && bybit?.state.connected) {
          // Determine the correct quantity to buy or sell
          let qty = 0;
          if (tradeSignal.type === "buy") {
            qty = positionUsd / snapshot.price;
          } else if (tradeSignal.type === "sell") {
            const existing = portfolio.positions.find(p => p.symbol === tradeSignal.symbol);
            qty = existing ? existing.quantity : 0.01; // fallback
          }

          if (qty <= 0) {
            statusMessage = `${mode.toUpperCase()} | zero quantity for ${tradeSignal.symbol}`;
            continue;
          }

          // Execute via Bybit REST API
          result = await bybit.placeOrder(tradeSignal, qty);
        } else {
          // Execute via simulated paper trading
          result = await execute(tradeSignal, config);
        }

        portfolio = update(portfolio, result);
        statusMessage = `${mode.toUpperCase()} | ${result.side} ${result.symbol} @ $${result.price.toFixed(2)}`;

        if (result.side === "buy") recordEntry(tradeSignal, result);
        if (result.side === "sell") {
          const closed = recordExit(symbol, result.price, result.timestamp, result.fee);
          if (closed) statusMessage += ` | P&L: ${(closed.pnl ?? 0) >= 0 ? "+" : ""}$${(closed.pnl ?? 0).toFixed(2)}`;
        }

        broadcast("trade", {
          tradeHistory: getHistory(),
          performanceReport: null,
          learningInsights: [],
          strategyParams,
        });
      } else {
        statusMessage = `${mode.toUpperCase()} | ${tradeSignal.reason || "no signal"}`;
      }
    }
  }

  // ── Dashboard + UI update ──────────────────────────────────────────
  function updateDashboardAndUI(): void {
    dashboardState.marketData = latestMarketData;
    dashboardState.portfolio = portfolio;
    dashboardState.lastSignal = lastSignal;
    dashboardState.statusMessage = statusMessage;
    dashboardState.tradeHistory = getHistory();
    dashboardState.performanceReport = performanceReport;
    dashboardState.learningInsights = learningInsights;
    dashboardState.strategyParams = strategyParams;
    dashboardState.deploymentRatio = deploymentRatio(portfolio);
    dashboardState.operatingCapitalUsd = portfolio.maxCapitalUsd;

    appState.marketData = latestMarketData;
    appState.portfolio = portfolio;
    appState.lastSignal = lastSignal;
    appState.statusMessage = statusMessage;
    render(appState);

    broadcast("market", {
      marketData: Object.fromEntries(latestMarketData),
      portfolio,
      statusMessage,
      mode,
    });
  }

  // ── Periodic learning cycle ────────────────────────────────────────
  async function runLearningCycle(): Promise<void> {
    const closedTrades = getClosedTrades();
    if (closedTrades.length < 3) return;

    performanceReport = analyzePerformance(initialCash);

    strategyParams = optimize(
      strategyParams,
      performanceReport.winRate,
      closedTrades.length,
      performanceReport.avgWin,
      Math.abs(performanceReport.avgLoss),
      performanceReport.maxDrawdown,
      closedTrades.slice(-10).map(t => t.pnl ?? 0),
    );

    const newInsights = getInsights().filter(
      i => !learningInsights.find(e => e.round === i.round)
    );
    learningInsights.push(...newInsights);

    console.log(`[learning] Win rate: ${(performanceReport.winRate * 100).toFixed(1)}% | Trades: ${closedTrades.length}`);
    if (newInsights.length > 0) {
      console.log(`[learning] Adjustments: ${newInsights.map(i => i.reason).join("; ")}`);
    }

    broadcast("learning", {
      insights: newInsights,
      params: strategyParams,
      report: performanceReport,
    });
  }

  // ── Main timer loop ────────────────────────────────────────────────
  // Runs trading cycle + learning + UI update at refreshIntervalMs
  let bybit: BybitConnector | undefined;

  const timer = setInterval(async () => {
    try {
      await runTradingCycle();
      const now = Date.now();
      if (now - lastLearningRound >= learningInterval) {
        lastLearningRound = now;
        await runLearningCycle();
      }
      updateDashboardAndUI();
    } catch (err) {
      console.error("[cycle] Error in trading cycle:", err);
    }
  }, config.refreshIntervalMs);

  // ── BYBIT BRANCH ───────────────────────────────────────────────────
  if (useBybit) {
    const bybitConfig: BybitConfig = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      testnet: mode !== "live",
      symbols: config.symbols.map(appSymbolToBybit),
      wsPingIntervalMs: 20000,
      maxRetries: 5,
    };

    bybit = new BybitConnector(bybitConfig);

    // Connection state → dashboard
    bybit.onConnection((state: BybitConnectorState) => {
      dashboardState.bybitConnected = state.connected;
      dashboardState.bybitLatencyMs = state.latencyMs;
      dashboardState.bybitMode = state.mode;
      dashboardState.bybitError = state.error;
    });

    // Real-time tickers → latestMarketData (used by the timer loop)
    bybit.onTicker((snapshots: Map<string, MarketSnapshot>) => {
      // Merge updates so we keep all symbols on the dashboard
      for (const [sym, snap] of snapshots) {
        latestMarketData.set(sym, snap);
      }

      // Push to dashboard immediately (tickers stream at 100ms)
      dashboardState.marketData = latestMarketData;
      broadcast("market", {
        marketData: Object.fromEntries(latestMarketData),
        portfolio,
        statusMessage,
        mode,
      });
    });

    // Connect Bybit
    try {
      statusMessage = "connecting to Bybit...";
      render(appState);
      await bybit.connect();
      statusMessage = `Bybit ${bybit.state.mode.toUpperCase()} — ${config.symbols.length} symbols`;
      console.log(`[bybit] Connected. Mode: ${bybit.state.mode}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      statusMessage = `Bybit connection failed: ${errorMsg}. Paper mode.`;
      console.error(`[bybit] ${statusMessage}`);
      dashboardState.bybitError = errorMsg;
      dashboardState.bybitConnected = false;
    }
  } else {
    // ── PAPER/SIMULATED BRANCH ───────────────────────────────────────
    const simSignal = new AbortController();
    (async () => {
      for await (const snapshots of watch(config.symbols, config.refreshIntervalMs, simSignal.signal)) {
        latestMarketData = snapshots;
      }
    })();

    // Stop simulator on main abort
    if (signal) {
      signal.addEventListener("abort", () => simSignal.abort(), { once: true });
    }
  }

  // ── Wait for abort ─────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    if (signal) {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });

  // Cleanup
  clearInterval(timer);
  bybit?.disconnect();
  await server.close();
}

// CLI entry point
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
  console.error("Usage: node src/main.ts --config ./config.json [--live] [--port 3081]");
  process.exit(1);
}