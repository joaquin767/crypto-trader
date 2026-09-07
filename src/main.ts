import { loadConfig, type Config } from "./config.ts";
import { watch, type MarketSnapshot } from "./market.ts";
import { analyze, type TradeSignal, clearHistory } from "./strategy/signals.ts";
import { calcPositionSize } from "./strategy/risk.ts";
import { create, update, canAfford, deploymentRatio, markToMarket, type Portfolio, type Position } from "./portfolio.ts";
import { execute, type TradeResult } from "./executor.ts";
import { render, type AppState } from "./tui.ts";
import { recordEntry, recordExit, getClosedTrades, getHistory, clearJournal, reconstructPortfolio, type TradeRecord, type TradeVenue } from "./learning/journal.ts";
import { analyze as analyzePerformance, type PerformanceReport } from "./learning/analyzer.ts";
import { defaultParams, optimize, getInsights, type StrategyParams, type LearningInsight } from "./learning/optimizer.ts";
import { createServer, broadcast, type DashboardState } from "./server/index.ts";
import { BybitConnector, type BybitConnectorState } from "./bybit/connector.ts";
import { BybitInsufficientBalanceError, BybitInvalidQtyError, BybitFatalError, BybitFillUncertainError } from "./bybit/types.ts";
import { appSymbolToBybit } from "./bybit/adapters.ts";
import type { BybitConfig } from "./bybit/types.ts";
import { logger } from "./logger.ts";
import { recommendSymbols, checkConfiguredSymbols } from "./strategy/symbol-recommender.ts";
import { acquireInstanceLock } from "./instance-lock.ts";

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
  let useBybit = config.exchange.toLowerCase() === "bybit";
  // Refuse to start a second instance trading the same real account (see
  // specs/live-trading-readiness.md §7.3/F6) — two unsynchronized local
  // portfolios against one account is a direct path to doubled risk exposure.
  // Scoped to useBybit only: pure paper/simulated mode has no real account to
  // protect. Throws InstanceLockError (uncaught here — deliberately fatal;
  // this must stop startup, not be logged and continued past).
  const instanceLock = useBybit ? acquireInstanceLock(config.apiKey) : null;
  let bybitFallenBack = false; // flag to prevent onConnection from overwriting error state after fallback
  // Set on a fatal Bybit account error (banned/restricted — see BybitFatalError).
  // Unlike bybitFallenBack, this halts ALL trading (not just Bybit trading) and
  // is never cleared automatically — the account issue needs the user's attention.
  let fatalHalt = false;
  // Fixed for the life of this run — derived from the same flags that decide
  // bybitConfig.testnet, so it always matches bybit.state.mode. Every journaled
  // trade is tagged with this so paper/testnet/live results can never blend
  // (see specs/live-trading-readiness.md §6.3).
  const venue: TradeVenue = !useBybit ? "paper" : mode === "live" ? "bybit-live" : "bybit-testnet";
  // Symbols with new-entry trading blocked after a real Bybit rejection
  // (insufficient balance / qty too small). Closing trades for these symbols
  // are never blocked — only entries. Cleared on restart (see §6.2/§13.3).
  const haltedSymbols = new Set<string>();

  let portfolio: Portfolio = create(config.maxCapitalUsd);
  // Recover open positions from previous session — only ever this run's venue.
  portfolio = reconstructPortfolio(portfolio, new Map(), venue);
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
  logger.info(`Dashboard: http://localhost:${port}`);
  logger.info(`Mode: ${mode.toUpperCase()}`);
  if (useBybit) logger.info("Exchange: BYBIT (WebSocket tickers + REST orders)");

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
    if (fatalHalt) {
      statusMessage = "🔴 HALTED — Bybit account error requires attention. Restart after resolving on Bybit.";
      return;
    }

    if (latestMarketData.size === 0) return;

    // Refuse to trade off a feed that's gone quiet. Without this, an exhausted
    // WebSocket reconnect (before REST polling catches up, or if it's also
    // failing) would leave the bot acting on a price that stopped updating —
    // the dashboard's "connected" flag alone doesn't guarantee fresh ticks.
    if (useBybit && bybit) {
      const lastTick = bybit.state.lastTickerTime;
      const staleAfterMs = Math.max(15000, config.refreshIntervalMs * 5);
      if (lastTick > 0 && Date.now() - lastTick > staleAfterMs) {
        statusMessage = `⚠️ Bybit market data stale (no ticks for ${Math.round((Date.now() - lastTick) / 1000)}s) — pausing trading until it recovers`;
        return;
      }
    }

    for (const [symbol, snapshot] of latestMarketData) {
      if (config.maxDailyTrades > 0 && portfolio.dailyTradeCount >= config.maxDailyTrades) {
        statusMessage = `daily trade limit reached (${config.maxDailyTrades})`;
        continue;
      }

      const tradeSignal = analyze(snapshot, portfolio, config);
      lastSignal = tradeSignal;

      if (tradeSignal.type === "buy" || tradeSignal.type === "sell") {
        // Skip sell signals if we don't have an open position in that symbol
        if (tradeSignal.type === "sell") {
          const existing = portfolio.positions.find(p => p.symbol === tradeSignal.symbol);
          if (!existing) {
            statusMessage = `${mode.toUpperCase()} | HOLD (no position to close for ${tradeSignal.symbol})`;
            continue;
          }
        }

        // A prior real Bybit rejection (insufficient balance / qty too small) blocks
        // only NEW entries for this symbol — closes are never blocked (see §6.2).
        if (tradeSignal.type === "buy" && haltedSymbols.has(tradeSignal.symbol)) {
          statusMessage = `⚠️ Entries halted for ${tradeSignal.symbol} (prior Bybit rejection) — closes still active`;
          continue;
        }

        // Sizing only applies to opening a new position — a close always sells the
        // full held quantity (computed below from portfolio.positions), never a
        // fraction of cash. calcPositionSize() naturally returns ~0 when cash is
        // low, which is exactly when a stop-loss/take-profit close is most likely
        // to fire (cash is low because capital is deployed in the position being
        // closed) — gating on it here would have silently skipped real closes.
        let positionUsd = 0;
        if (tradeSignal.type === "buy") {
          positionUsd = calcPositionSize(tradeSignal.confidence, portfolio, config);
          if (positionUsd <= 0) {
            statusMessage = `${mode.toUpperCase()} | insufficient cash for ${tradeSignal.symbol}`;
            continue;
          }
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
          try {
            result = await bybit.placeOrder(tradeSignal, qty, portfolio.cashUsd);
          } catch (bybitErr) {
            if (bybitErr instanceof BybitInsufficientBalanceError) {
              // Real rejection from a real order. Per specs/live-trading-readiness.md
              // §6.2: never disconnect, never fabricate a substitute trade — that
              // combination previously let the bot mark a real position "closed" in
              // its own books at a fantasy price while it stayed open, unmanaged, on
              // Bybit. Only new entries for this symbol are blocked; the connection,
              // WS position feed, and closes all stay fully active.
              haltedSymbols.add(tradeSignal.symbol);
              statusMessage = `⚠️ Bybit insufficient balance for ${tradeSignal.symbol} — entries halted. Fund your testnet wallet.`;
              logger.warn(`Bybit insufficient balance for ${tradeSignal.symbol} — entries halted, closes still active.`);
              logger.info("To trade on Bybit: transfer USDT to your Unified Trading Account in Bybit (Assets > Transfer > Funding → Unified Trading Account)");
              continue;
            } else if (bybitErr instanceof BybitInvalidQtyError) {
              haltedSymbols.add(tradeSignal.symbol);
              statusMessage = `⚠️ Bybit rejected order for ${tradeSignal.symbol} (qty too small) — entries halted.`;
              logger.warn(`Bybit rejected order for ${tradeSignal.symbol} (qty too small) — entries halted, closes still active.`);
              continue;
            } else if (bybitErr instanceof BybitFatalError) {
              // Account-level ban/restriction (see anti-ban spec §9D). This is never
              // safe to retry or paper-fallback from silently — stop everything and
              // make the problem impossible to miss until the user resolves it.
              fatalHalt = true;
              statusMessage = `🔴 HALTED — Bybit fatal error [${bybitErr.retCode}]: ${bybitErr.message}`;
              logger.error(statusMessage);
              bybit.disconnect();
              dashboardState.bybitConnected = false;
              dashboardState.bybitError = statusMessage;
              return;
            } else if (bybitErr instanceof BybitFillUncertainError) {
              // We placed the order but can't confirm what actually filled, even
              // after polling. Do NOT fabricate a trade result (that's the bug that
              // used to corrupt the portfolio) — skip this cycle and keep trying;
              // this doesn't necessarily mean the account is broken.
              statusMessage = `⚠️ Bybit order status unknown for ${tradeSignal.symbol} — check manually. ${bybitErr.message}`;
              logger.error(statusMessage);
              continue;
            } else {
              throw bybitErr;
            }
          }
        } else {
          // Execute via simulated paper trading — only reached when Bybit isn't
          // configured/connected at all, never as a mid-session substitute for a
          // real order (see §6.2). Always priced off the real snapshot and sized
          // identically to the Bybit path.
          result = await execute(tradeSignal, config, portfolio, snapshot, positionUsd);
        }

        try {
          portfolio = update(portfolio, result);
        } catch (err) {
          // portfolio.update() refuses NaN/negative trade data rather than silently
          // corrupting cashUsd. Skip journaling this one instead of bricking the session.
          logger.error(`Refusing corrupted trade result for ${result.symbol}: ${(err as Error).message}`);
          statusMessage = `⚠️ Trade result looked corrupted for ${result.symbol} — skipped. Check logs/Bybit manually.`;
          continue;
        }
        statusMessage = `${mode.toUpperCase()} | ${result.side} ${result.symbol} @ $${result.price.toFixed(2)}`;
        // Only log trades with valid values (not NaN from failed SDK responses)
        if (!Number.isNaN(result.quantity) && result.side !== "hold") {
          logger.trade(`${result.side} ${result.symbol}`, `qty=${result.quantity.toFixed(4)}`, `price=$${result.price.toFixed(2)}`, `fee=$${result.fee.toFixed(4)}`);
        }

        if (result.side === "buy") recordEntry(tradeSignal, result, venue);
        if (result.side === "sell") {
          const closed = recordExit(symbol, result.price, result.timestamp, result.fee);
          if (closed) statusMessage += ` | P&L: ${(closed.pnl ?? 0) >= 0 ? "+" : ""}$${(closed.pnl ?? 0).toFixed(2)}`;
        }

        // Update performance report on every trade so the equity curve updates.
        // Scoped to this run's venue — see §6.3, paper/real results never blend.
        performanceReport = analyzePerformance(initialCash, venue);

        broadcast("trade", {
          tradeHistory: getHistory(venue),
          performanceReport,
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
    dashboardState.tradeHistory = getHistory(venue);
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
      performanceReport,
      bybitConnected: dashboardState.bybitConnected,
      bybitLatencyMs: dashboardState.bybitLatencyMs,
      bybitMode: dashboardState.bybitMode,
      bybitError: dashboardState.bybitError,
      operatingCapitalUsd: dashboardState.operatingCapitalUsd,
      walletTotalUsd: dashboardState.walletTotalUsd,
      deploymentRatio: dashboardState.deploymentRatio,
    });
  }

  // ── Periodic learning cycle ────────────────────────────────────────
  async function runLearningCycle(): Promise<void> {
    const closedTrades = getClosedTrades(venue);
    if (closedTrades.length < 3) return;

    performanceReport = analyzePerformance(initialCash, venue);

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

    logger.info(`Learning: win rate ${(performanceReport.winRate * 100).toFixed(1)}% | Trades: ${closedTrades.length}`);
    if (newInsights.length > 0) {
      logger.info(`Learning: adjustments: ${newInsights.map(i => i.reason).join("; ")}`);
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
      logger.error("Error in trading cycle:", err);
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
      restPollIntervalMs: config.refreshIntervalMs,
    };

    bybit = new BybitConnector(bybitConfig);

    // Auto-select symbols for small capital if enabled. This MUST run before
    // bybit.connect() — the WebSocket subscribes to whatever's in
    // bybitConfig.symbols at that point (see WsClient subscribe in
    // BybitConnector.connect()), so recommendations discovered after connecting
    // would just be logged and never actually traded (the bug this replaces).
    // bybitConfig is the same object reference the connector holds as its
    // internal config, so mutating bybitConfig.symbols here is picked up.
    if (config.autoSelectSymbols) {
      try {
        logger.info("Analyzing best symbols for your capital...");
        const recommendations = await recommendSymbols(bybit.rest, config.maxCapitalUsd, config.maxPositionSizeUsd, 3);
        if (recommendations.length > 0) {
          logger.info("=".repeat(50));
          logger.info("RECOMMENDED SYMBOLS FOR YOUR CAPITAL:");
          logger.info("-".repeat(50));
          for (const rec of recommendations) {
            const canBuy = Math.floor(config.maxCapitalUsd / rec.minTradeCost);
            logger.info(`  ${rec.symbol.padEnd(10)} $${rec.price.toFixed(2).padEnd(8)} min: $${rec.minTradeCost.toFixed(2).padEnd(8)} ${rec.reason} (${canBuy}x in budget)`);
          }
          logger.info("-".repeat(50));
          logger.info(`Previously configured: ${config.symbols.join(", ")}`);

          // Keep any symbol with an open position subscribed even if it didn't
          // make the recommendations — otherwise the bot would lose its ticker
          // feed for that position and could never generate a stop-loss/take-
          // profit sell signal for it again.
          const recommendedSymbols = recommendations.map(r => r.symbol);
          const heldSymbols = portfolio.positions.map(p => p.symbol).filter(s => !recommendedSymbols.includes(s));
          if (heldSymbols.length > 0) {
            logger.info(`Keeping open position symbol(s) subscribed too: ${heldSymbols.join(", ")}`);
          }
          const finalSymbols = [...recommendedSymbols, ...heldSymbols];

          config.symbols = finalSymbols;
          bybitConfig.symbols = finalSymbols.map(appSymbolToBybit);
          logger.info(`Auto-selected for this session: ${config.symbols.join(", ")}`);
          logger.info("=".repeat(50));
        } else {
          logger.warn("Symbol analysis returned no recommendations — keeping configured symbols.");
        }
      } catch (err) {
        logger.warn(`Symbol analysis skipped, keeping configured symbols: ${(err as Error).message}`);
      }
    } else {
      // Even without auto-select, check if current symbols are affordable
      try {
        const checks = await checkConfiguredSymbols(bybit.rest, config.symbols, config.maxCapitalUsd);
        const unaffordable = checks.filter(c => !c.affordable);
        if (unaffordable.length > 0) {
          logger.warn("Some symbols may be too expensive for your capital:");
          for (const c of unaffordable) {
            logger.warn(`  ${c.symbol}: minimum ~$${c.minTradeCost.toFixed(2)} per trade (capital: $${config.maxCapitalUsd})`);
          }
          logger.info("Tip: set autoSelectSymbols: true in config.json to auto-pick the best symbols");
        }
      } catch { /* skip check */ }
    }

    // Connection state → dashboard
    bybit.onConnection((state: BybitConnectorState) => {
      // If we've already fallen back to paper mode, ignore all Bybit events
      if (bybitFallenBack || !useBybit) return;
      dashboardState.bybitConnected = state.connected;
      dashboardState.bybitLatencyMs = state.latencyMs;
      dashboardState.bybitMode = state.mode;
      dashboardState.bybitError = state.connected ? null : state.error;
      if (state.connected) {
        statusMessage = `Bybit ${state.mode.toUpperCase()} live`;
      }
    });

    // Confirmed fills from the private stream — observability only for now (REST
    // is still the source of truth for what we journal), but logging them makes
    // it possible to spot a fill the REST ack path missed.
    bybit.onTrade((result: TradeResult) => {
      logger.info(`[bybit:ws] Confirmed fill via private stream: ${result.side} ${result.symbol} qty=${result.quantity} @ $${result.price}`);
    });

    // Lightweight drift check: warn loudly if Bybit's own position reports ever
    // disagree with what the bot believes it holds. This does not mutate state —
    // it's a signal for the user to investigate (restart to re-reconcile).
    bybit.onPosition((positions: Position[]) => {
      for (const exch of positions) {
        if (Math.abs(exch.quantity) <= 0) continue;
        const local = portfolio.positions.find(p => p.symbol === exch.symbol);
        if (!local) {
          logger.warn(`[bybit] Position drift: Bybit reports an open ${exch.symbol} position (qty ${exch.quantity}) not tracked locally. Restart to reconcile, or check Bybit manually.`);
        } else if (Math.abs(local.quantity - exch.quantity) > Math.max(1e-8, exch.quantity * 0.01)) {
          logger.warn(`[bybit] Position drift for ${exch.symbol}: local qty ${local.quantity} vs Bybit qty ${exch.quantity}.`);
        }
      }
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
        performanceReport,
        // bybitConnected etc. only ever get set on dashboardState directly (by
        // onConnection, below) — this broadcast previously never carried them,
        // so a browser tab open across a reconnect/status change never saw it
        // update until the page was reloaded and re-read dashboardState fresh.
        bybitConnected: dashboardState.bybitConnected,
        bybitLatencyMs: dashboardState.bybitLatencyMs,
        bybitMode: dashboardState.bybitMode,
        bybitError: dashboardState.bybitError,
        operatingCapitalUsd: dashboardState.operatingCapitalUsd,
        walletTotalUsd: dashboardState.walletTotalUsd,
        deploymentRatio: dashboardState.deploymentRatio,
      });
    });

    // Connect Bybit
    try {
      statusMessage = "connecting to Bybit...";
      render(appState);
      await bybit.connect();
      statusMessage = `Bybit ${bybit.state.mode.toUpperCase()} — ${config.symbols.length} symbols`;
      logger.info(`Bybit connected. Mode: ${bybit.state.mode}`);

      // Reconcile local (journal-derived) positions against what Bybit actually
      // reports. Without this, a crash between a real fill and journaling it would
      // leave that position permanently untracked — the bot would never generate a
      // sell signal for it because it doesn't believe it holds anything.
      try {
        const { merged, unaccountedFor, warnings } = await bybit.reconcilePositions(portfolio.positions);
        for (const w of warnings) logger.warn(`[reconcile] ${w}`);
        if (warnings.length > 0 || merged.length !== portfolio.positions.length) {
          portfolio = { ...portfolio, positions: merged, totalValueUsd: markToMarket(portfolio.cashUsd, merged) };
          logger.info(`[reconcile] Portfolio positions reconciled with Bybit: ${merged.length} open position(s).`);
        }
        if (unaccountedFor.length > 0) {
          const summary = unaccountedFor.map(p => `${p.symbol} qty ${p.quantity}`).join(", ");
          statusMessage = `⚠️ Bybit has position(s) not opened by this bot (${summary}) — not auto-trading them, please review on Bybit.`;
          logger.error(`[reconcile] Unaccounted-for exchange position(s): ${summary}. These were NOT added to the tradeable portfolio — check your Bybit account manually.`);
        }
      } catch (err) {
        logger.warn(`[reconcile] Position reconciliation skipped: ${(err as Error).message}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      statusMessage = `Bybit connection failed: ${errorMsg}. Paper mode.`;
      logger.error(`Bybit connection failed: ${errorMsg}`);
      bybitFallenBack = true; // prevent onConnection from re-setting error state
      dashboardState.bybitError = null;
      dashboardState.bybitConnected = false;
      dashboardState.bybitMode = "paper";
      updateDashboardAndUI();
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
  instanceLock?.release();
  await server.close();
}

// CLI entry point
const cliArgs = parseArgs(process.argv.slice(2));
if (cliArgs.configPath) {
  try {
    const config = loadConfig(cliArgs.configPath);
    logger.info("Starting crypto-trader");
    start(config).catch((err) => {
      logger.error("Fatal error:", err);
      process.exit(1);
    });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  logger.error("Usage: node src/main.ts --config ./config.json [--live] [--port 3081]");
  process.exit(1);
}