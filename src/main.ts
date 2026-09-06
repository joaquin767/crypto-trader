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

export { loadConfig, type Config };
export { type MarketSnapshot };
export { analyze, type TradeSignal, getHistory as getSignalHistory } from "./strategy/signals.ts";
export { type TradeRecord, getHistory as getJournalHistory } from "./learning/journal.ts";

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
 * 1. Loads config
 * 2. Starts market watcher
 * 3. For each snapshot: analyzes indicators → generates signal → executes → journals → broadcasts
 * 4. Periodically runs learning: analyze performance → optimize strategy params → broadcast insights
 * 5. Web dashboard at http://localhost:<port>
 */
export async function start(config: Config, signal?: AbortSignal): Promise<void> {
  const mode = (process.argv.includes("--live") ? "live" : "paper") as "paper" | "live";
  const port = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? "3081");

  let portfolio: Portfolio = create(config.maxCapitalUsd);
  let lastSignal: TradeSignal | null = null;
  let statusMessage = "starting...";
  let strategyParams: StrategyParams = defaultParams();
  let performanceReport: PerformanceReport | null = null;
  const learningInsights: LearningInsight[] = [];

  // Learning timer
  let lastLearningRound = Date.now();
  const learningInterval = 30000; // every 30s

  // Track the last price per symbol for exit recording
  const lastPrices = new Map<string, number>();

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

  for await (const snapshots of watch(config.symbols, config.refreshIntervalMs, signal)) {
    dashboardState.marketData = snapshots;
    appState.marketData = snapshots;

    for (const [symbol, snapshot] of snapshots) {
      lastPrices.set(symbol, snapshot.price);

      // Check daily trade limit
      if (config.maxDailyTrades > 0 && portfolio.dailyTradeCount >= config.maxDailyTrades) {
        statusMessage = `daily trade limit reached (${config.maxDailyTrades})`;
        continue;
      }

      // Expert analysis with multiple indicators
      const tradeSignal = analyze(snapshot, portfolio, config);
      lastSignal = tradeSignal;

      if (tradeSignal.type === "buy" || tradeSignal.type === "sell") {
        // Kelly Criterion position sizing
        const positionUsd = calcPositionSize(tradeSignal.confidence, portfolio, config);

        if (positionUsd <= 0) {
          statusMessage = `${mode.toUpperCase()} | insufficient cash for ${tradeSignal.symbol}`;
          continue;
        }

        // Execute
        const result: TradeResult = await execute(tradeSignal, config);
        portfolio = update(portfolio, result);
        statusMessage = `${mode.toUpperCase()} | ${result.side} ${result.symbol} @ $${result.price.toFixed(2)}`;

        // Journal the trade
        if (result.side === "buy") {
          recordEntry(tradeSignal, result);
        }

        // If selling, close the journal entry
        if (result.side === "sell") {
          const closed = recordExit(symbol, result.price, result.timestamp, result.fee);
          if (closed) {
            statusMessage += ` | P&L: ${(closed.pnl ?? 0) >= 0 ? "+" : ""}$${(closed.pnl ?? 0).toFixed(2)}`;
          }
        }

        // Broadcast trade event
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

    // Periodic learning cycle
    const now = Date.now();
    if (now - lastLearningRound >= learningInterval) {
      lastLearningRound = now;

      const closedTrades = getClosedTrades();
      if (closedTrades.length >= 3) {
        performanceReport = analyzePerformance(initialCash);

        // Calculate metrics for optimizer
        const recentPnls = closedTrades.slice(-10).map(t => t.pnl ?? 0);

        strategyParams = optimize(
          strategyParams,
          performanceReport.winRate,
          closedTrades.length,
          performanceReport.avgWin,
          Math.abs(performanceReport.avgLoss),
          performanceReport.maxDrawdown,
          recentPnls,
        );

        // Collect new insights
        const newInsights = getInsights().filter(
          i => !learningInsights.find(e => e.round === i.round)
        );
        learningInsights.push(...newInsights);

        console.log(`[learning] Win rate: ${(performanceReport.winRate * 100).toFixed(1)}% | Trades: ${closedTrades.length}`);
        if (newInsights.length > 0) {
          console.log(`[learning] Adjustments: ${newInsights.map(i => i.reason).join("; ")}`);
        }

        // Broadcast learning event
        broadcast("learning", {
          insights: newInsights,
          params: strategyParams,
          report: performanceReport,
        });
      }
    }

    // Update dashboard state
    portfolio = portfolio; // already updated above
    dashboardState.portfolio = portfolio;
    dashboardState.lastSignal = lastSignal;
    dashboardState.statusMessage = statusMessage;
    dashboardState.tradeHistory = getHistory();
    dashboardState.performanceReport = performanceReport;
    dashboardState.learningInsights = learningInsights;
    dashboardState.strategyParams = strategyParams;
    dashboardState.deploymentRatio = deploymentRatio(portfolio);
    dashboardState.operatingCapitalUsd = portfolio.maxCapitalUsd;

    // Update terminal render
    appState.portfolio = portfolio;
    appState.lastSignal = lastSignal;
    appState.statusMessage = statusMessage;
    render(appState);

    // Broadcast market update
    broadcast("market", {
      marketData: Object.fromEntries(snapshots),
      portfolio,
      statusMessage,
      mode,
    });
  }

  // Cleanup
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