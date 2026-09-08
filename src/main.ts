import { loadConfig, type Config } from "./config.ts";
import { watch, type MarketSnapshot } from "./market.ts";
import { analyze, checkImmediateExit, type TradeSignal, clearHistory, getHistory as getPriceHistory, setHistory as setPriceHistory } from "./strategy/signals.ts";
import { calcPositionSize } from "./strategy/risk.ts";
import { checkConcurrentPositionsLimit, checkCorrelationLimit } from "./strategy/concentration.ts";
import { recordTick, seedCandles, takeCompletedCandle, DEFAULT_INTERVAL_MS } from "./strategy/candles.ts";
import { loadModel } from "./strategy/model.ts";
import { create, update, canAfford, deploymentRatio, markToMarket, type Portfolio, type Position } from "./portfolio.ts";
import { execute, type TradeResult } from "./executor.ts";
import { render, type AppState } from "./tui.ts";
import { recordEntry, recordExit, getClosedTrades, getHistory, clearJournal, reconstructPortfolio, type TradeRecord, type TradeVenue } from "./learning/journal.ts";
import { analyze as analyzePerformance, type PerformanceReport } from "./learning/analyzer.ts";
import { createServer, broadcast, type DashboardState } from "./server/index.ts";
import { BybitConnector, type BybitConnectorState } from "./bybit/connector.ts";
import { BybitInsufficientBalanceError, BybitInvalidQtyError, BybitFatalError, BybitFillUncertainError, BybitAuthError } from "./bybit/types.ts";
import { appSymbolToBybit, bybitSymbolToApp } from "./bybit/adapters.ts";
import type { BybitConfig, BybitPosition } from "./bybit/types.ts";
import { logger } from "./logger.ts";
import { recommendSymbols, checkConfiguredSymbols } from "./strategy/symbol-recommender.ts";
import { acquireInstanceLock } from "./instance-lock.ts";
import {
  createCircuitBreakerState, checkEquityBreakers, recordTradeOutcome, checkConsecutiveLosses,
  checkSlippage, DEFAULT_CIRCUIT_BREAKER_CONFIG, type CircuitBreakerConfig, type CircuitBreakerTrip,
} from "./risk/circuit-breaker.ts";
import { assertCapitalThresholdOk } from "./startup-safety.ts";
import { createWalletMonitorState, checkWalletShortfall } from "./risk/wallet-monitor.ts";

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
  // First gate, before anything else happens — see specs/live-trading-readiness.md
  // §7.2. Throws StartupSafetyError (uncaught here, deliberately fatal) if a
  // --live run's maxCapitalUsd is above the safety threshold and either the
  // confirmation phrase wasn't typed (interactive) or there's nobody to ask
  // (non-interactive, e.g. a background service — exactly where an unattended
  // large-capital run is least supervised).
  await assertCapitalThresholdOk(config, mode, logger);
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
  // Why each symbol is halted. Entries land in haltedSymbols from five
  // different conditions (exchange rejection, qty rejection, slippage,
  // leverage drift, liquidation proximity) and the dashboard previously had
  // no way to tell them apart — so it labelled every one "after an exchange
  // rejection", which was wrong for the leverage-drift case and unhelpful
  // for the rest.
  const haltReasons = new Map<string, string>();

  let portfolio: Portfolio = create(config.maxCapitalUsd);
  // Recover open positions from previous session — only ever this run's venue.
  portfolio = reconstructPortfolio(portfolio, new Map(), venue);

  // Portfolio-level circuit breakers (spec §5). `??` (not `||`) so an explicit
  // `false` — disabling a trigger — is preserved rather than falling back to
  // the default; only an actually-missing field (undefined) uses the default.
  const circuitBreakerConfig: CircuitBreakerConfig = {
    maxDailyLossPercent: config.maxDailyLossPercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDailyLossPercent,
    maxDrawdownHaltPercent: config.maxDrawdownHaltPercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDrawdownHaltPercent,
    maxConsecutiveLosses: config.maxConsecutiveLosses ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxConsecutiveLosses,
    maxSlippagePercent: config.maxSlippagePercent ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxSlippagePercent,
  };
  let circuitBreakerState = createCircuitBreakerState(portfolio.totalValueUsd);
  // Portfolio-wide (unlike haltedSymbols, which is per-symbol) — blocks new
  // entries for EVERY symbol, never closes. Cleared only by restart (§13.3).
  let circuitBreakerTripped: CircuitBreakerTrip | null = null;
  // Wallet-vs-ledger sanity check (spec §8.3) — informational only, never
  // changes cashUsd.
  let walletMonitorState = createWalletMonitorState();

  // Snapshot of the entry model actually in force, for the dashboard.
  const loadedModel = config.useModelGate ? loadModel() : null;
  const modelInfo = loadedModel === null ? null : {
    enabled: true,
    minProbability: config.modelMinProbability ?? 0.5,
    testAuc: loadedModel.metrics.testAuc,
    horizonBars: loadedModel.trainedOn.horizonBars,
    interval: loadedModel.trainedOn.interval,
    tp: loadedModel.trainedOn.takeProfitPercent,
    sl: loadedModel.trainedOn.stopLossPercent,
  };

  let lastSignal: TradeSignal | null = null;
  // Latest decision per symbol, for the dashboard's "why isn't it trading?"
  // panel. Plain object (not a Map) because it is serialised straight to SSE.
  const signalsBySymbol: Record<string, { type: string; confidence: number; reason: string; at: number }> = {};
  let statusMessage = "starting...";
  let performanceReport: PerformanceReport | null = null;

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
    bybitConnected: false,
    bybitLatencyMs: 0,
    bybitMode: "paper",
    bybitError: null,
    operatingCapitalUsd: config.maxCapitalUsd,
    walletTotalUsd: config.maxCapitalUsd,
    deploymentRatio: 0,
    fundingPnlUsd: 0,
  };
  // When funding was last fetched — see runLearningCycle. Starts at process
  // start; only meaningful once useBybit is true (see acquisition below).
  let lastFundingCheckMs = Date.now();

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

    // Portfolio-wide circuit breakers (spec §5) — checked once per cycle, before
    // any symbol is evaluated, off current mark-to-market equity. This only
    // ever sets circuitBreakerTripped; it never blocks the loop below from
    // running, because closes (and the stale-feed/daily-trade-limit checks
    // above) must keep working even while entries are halted.
    {
      const { state, trip } = checkEquityBreakers(circuitBreakerState, circuitBreakerConfig, portfolio.totalValueUsd, config.maxCapitalUsd);
      circuitBreakerState = state;
      if (trip && !circuitBreakerTripped) {
        circuitBreakerTripped = trip;
        statusMessage = `🔴 CIRCUIT BREAKER: ${trip.details}`;
        logger.error(`[circuit-breaker] ${trip.details}`);
      }
    }

    // Resolve any post-only entries resting on the book first. Placing one
    // no longer blocks the cycle (that would have delayed every other
    // symbol's stop-loss by up to postOnlyTimeoutMs), so fills are picked
    // up here, one cheap poll per resting order.
    if (useBybit && bybit?.state.connected) {
      try {
        for (const { symbol: filledSymbol, result } of await bybit.checkRestingOrders()) {
          try {
            portfolio = update(portfolio, result);
          } catch (err) {
            logger.error(`Refusing corrupted resting fill for ${filledSymbol}: ${(err as Error).message}`);
            continue;
          }
          logger.trade(`${result.side} ${result.symbol}`, `qty=${result.quantity.toFixed(4)}`, `price=$${result.price.toFixed(2)}`, `fee=$${result.fee.toFixed(4)}`);
          if (result.side === "buy") {
            const restingSignal = signalsBySymbol[filledSymbol];
            recordEntry({
              type: "buy", symbol: filledSymbol,
              confidence: restingSignal?.confidence ?? 0.5,
              reason: restingSignal?.reason ?? "post-only entry filled",
              indicators: lastSignal?.indicators ?? {
                rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false },
                bollinger: { upper: 0, middle: 0, lower: 0, width: 0 }, momentum: 0, atr: 0,
              },
            }, result, venue);
          }
          performanceReport = analyzePerformance(initialCash, venue);
        }
      } catch (err) {
        logger.error(`[bybit] Failed to check resting orders: ${(err as Error).message}`);
      }
    }

    const resting = useBybit && bybit ? new Set(bybit.restingSymbols()) : new Set<string>();

    for (const [symbol, snapshot] of latestMarketData) {
      if (config.maxDailyTrades > 0 && portfolio.dailyTradeCount >= config.maxDailyTrades) {
        statusMessage = `daily trade limit reached (${config.maxDailyTrades})`;
        continue;
      }

      // ── Two cadences, deliberately ──────────────────────────────────
      // Risk-reducing exits (stop-loss, take-profit, model-horizon expiry)
      // are checked on EVERY tick: they need only the cost basis, the price
      // and the clock, and delaying one by up to a full bar would be far
      // more dangerous than the noise problem this split exists to fix.
      //
      // Everything indicator-driven — entries, the expert exit, the model
      // gate, the confirmation-tick counter — runs ONCE PER CLOSED BAR, the
      // same cadence runBacktest() replays at. Previously all of it ran
      // every refreshIntervalMs (3s live vs 5m in the harness), so the two
      // were running measurably different strategies: RSI/Bollinger over
      // 3-second ticks rather than 5-minute closes, and
      // signalConfirmationTicks=2 meaning 6 seconds live but 10 minutes
      // backtested. Tuning against backtest numbers tuned a system that
      // didn't exist.
      //
      // Note the split: the DECISION is made on the bar's own close (so the
      // indicator series matches the harness bar-for-bar), but the ORDER is
      // sized and priced off the live snapshot below, because that's the
      // market you actually trade against.
      let tradeSignal: TradeSignal;
      const held = portfolio.positions.find(p => p.symbol === symbol);
      const urgent = held ? checkImmediateExit(held, snapshot, config) : null;

      if (urgent) {
        tradeSignal = {
          type: "sell", symbol, confidence: urgent.confidence, reason: urgent.reason,
          indicators: lastSignal?.indicators ?? {
            rsi: 50, macd: { macdLine: 0, signalLine: 0, histogram: 0, bullish: false },
            bollinger: { upper: 0, middle: 0, lower: 0, width: 0 }, momentum: 0, atr: 0,
          },
        };
      } else {
        const closedBar = takeCompletedCandle(symbol);
        if (!closedBar) continue;
        tradeSignal = analyze({
          symbol, price: closedBar.close, change24h: snapshot.change24h,
          volume24h: closedBar.volume, timestamp: closedBar.openTime,
          high24h: closedBar.high, low24h: closedBar.low,
        }, portfolio, config);
      }
      lastSignal = tradeSignal;
      // Recorded per symbol so the dashboard can explain why each symbol is
      // or isn't trading — with several independent entry gates, a bare
      // "no trades" tells the user nothing about which one declined.
      signalsBySymbol[symbol] = {
        type: tradeSignal.type,
        confidence: tradeSignal.confidence,
        reason: tradeSignal.reason,
        at: Date.now(),
      };

      if (tradeSignal.type === "buy" || tradeSignal.type === "sell") {
        // Skip sell signals if we don't have an open position in that symbol
        if (tradeSignal.type === "sell") {
          const existing = portfolio.positions.find(p => p.symbol === tradeSignal.symbol);
          if (!existing) {
            statusMessage = `${mode.toUpperCase()} | HOLD (no position to close for ${tradeSignal.symbol})`;
            continue;
          }
        }

        // A tripped circuit breaker (portfolio-wide) or a prior real Bybit
        // rejection (per-symbol) blocks only NEW entries — closes are never
        // blocked (see §5/§6.2).
        if (tradeSignal.type === "buy" && circuitBreakerTripped) {
          statusMessage = `🔴 Entries halted — circuit breaker tripped (${circuitBreakerTripped.trigger}). Closes still active.`;
          continue;
        }
        if (tradeSignal.type === "buy" && resting.has(tradeSignal.symbol)) {
          statusMessage = `${mode.toUpperCase()} | ${tradeSignal.symbol} already has a post-only entry resting`;
          continue;
        }
        if (tradeSignal.type === "buy" && haltedSymbols.has(tradeSignal.symbol)) {
          statusMessage = `⚠️ Entries halted for ${tradeSignal.symbol} (prior Bybit rejection) — closes still active`;
          continue;
        }

        // Concentration limits (spec §10) — only relevant when opening a new
        // position; an existing position closing doesn't add concentration.
        if (tradeSignal.type === "buy") {
          const concurrentCheck = checkConcurrentPositionsLimit(portfolio.positions.length, config.maxConcurrentPositions);
          if (concurrentCheck.skip) {
            statusMessage = `⚠️ Skipping entry for ${tradeSignal.symbol}: ${concurrentCheck.reason}`;
            continue;
          }
          const correlationCheck = checkCorrelationLimit(
            tradeSignal.symbol,
            getPriceHistory(tradeSignal.symbol).prices,
            portfolio.positions.map(p => ({ symbol: p.symbol, prices: getPriceHistory(p.symbol).prices })),
            config.maxCorrelation,
          );
          if (correlationCheck.skip) {
            statusMessage = `⚠️ Skipping entry for ${tradeSignal.symbol}: ${correlationCheck.reason}`;
            continue;
          }
        }

        // Sizing only applies to opening a new position — a close always sells the
        // full held quantity (computed below from portfolio.positions), never a
        // fraction of cash. calcPositionSize() naturally returns ~0 when cash is
        // low, which is exactly when a stop-loss/take-profit close is most likely
        // to fire (cash is low because capital is deployed in the position being
        // closed) — gating on it here would have silently skipped real closes.
        let positionUsd = 0;
        if (tradeSignal.type === "buy") {
          positionUsd = calcPositionSize(portfolio, config, tradeSignal.indicators.atr, snapshot.price);
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
              haltReasons.set(tradeSignal.symbol, "insufficient balance on Bybit");
              statusMessage = `⚠️ Bybit insufficient balance for ${tradeSignal.symbol} — entries halted. Fund your testnet wallet.`;
              logger.warn(`Bybit insufficient balance for ${tradeSignal.symbol} — entries halted, closes still active.`);
              logger.info("To trade on Bybit: transfer USDT to your Unified Trading Account in Bybit (Assets > Transfer > Funding → Unified Trading Account)");
              continue;
            } else if (bybitErr instanceof BybitInvalidQtyError) {
              haltedSymbols.add(tradeSignal.symbol);
              haltReasons.set(tradeSignal.symbol, "order rejected by Bybit (quantity too small)");
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
          if (closed) {
            statusMessage += ` | P&L: ${(closed.pnl ?? 0) >= 0 ? "+" : ""}$${(closed.pnl ?? 0).toFixed(2)}`;
            // Consecutive-loss circuit breaker (spec §5) — portfolio-wide, only
            // meaningful for real closed trades, so this lives here rather than
            // on every fill.
            circuitBreakerState = recordTradeOutcome(circuitBreakerState, closed.pnl ?? 0);
            const consecutiveTrip = checkConsecutiveLosses(circuitBreakerState, circuitBreakerConfig);
            if (consecutiveTrip && !circuitBreakerTripped) {
              circuitBreakerTripped = consecutiveTrip;
              logger.error(`[circuit-breaker] ${consecutiveTrip.details}`);
            }
          }
        }

        // Slippage circuit breaker (spec §5) — scoped to this one symbol, never
        // the whole portfolio. Checked against the price the signal was
        // evaluated at, which is `snapshot.price` from this cycle's iteration.
        if (result.side !== "hold") {
          const slippageTrip = checkSlippage(circuitBreakerConfig, result.symbol, snapshot.price, result.price);
          if (slippageTrip && !haltedSymbols.has(result.symbol)) {
            haltedSymbols.add(result.symbol);
            haltReasons.set(result.symbol, "fill price deviated too far from the signal price");
            statusMessage = `🔴 ${slippageTrip.details}`;
            logger.error(`[circuit-breaker] ${slippageTrip.details}`);
          }
        }

        // Update performance report on every trade so the equity curve updates.
        // Scoped to this run's venue — see §6.3, paper/real results never blend.
        performanceReport = analyzePerformance(initialCash, venue);

        broadcast("trade", {
          tradeHistory: getHistory(venue),
          performanceReport,
        });
      } else {
        statusMessage = `${mode.toUpperCase()} | ${tradeSignal.reason || "no signal"}`;
      }
    }
  }

  // ── Dashboard + UI update ──────────────────────────────────────────
  function updateDashboardAndUI(): void {
    dashboardState.signalsBySymbol = signalsBySymbol;
    dashboardState.haltedSymbols = [...haltedSymbols].map(sym => ({
      symbol: sym,
      reason: haltReasons.get(sym) ?? "entries halted",
      // A leftover position on a symbol this run doesn't trade is context,
      // not an alert — the dashboard uses this to stop shouting about it.
      active: config.symbols.includes(sym),
    }));
    dashboardState.model = modelInfo;
    dashboardState.slPercent = config.stopLossPercent;
    dashboardState.tpPercent = config.takeProfitPercent;
    dashboardState.marketData = latestMarketData;
    dashboardState.portfolio = portfolio;
    dashboardState.lastSignal = lastSignal;
    dashboardState.statusMessage = statusMessage;
    dashboardState.tradeHistory = getHistory(venue);
    dashboardState.performanceReport = performanceReport;
    dashboardState.deploymentRatio = deploymentRatio(portfolio);
    dashboardState.operatingCapitalUsd = portfolio.maxCapitalUsd;
    dashboardState.circuitBreakerTripped = circuitBreakerTripped;

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
      fundingPnlUsd: dashboardState.fundingPnlUsd,
      circuitBreakerTripped: dashboardState.circuitBreakerTripped,
      walletShortfallWarning: dashboardState.walletShortfallWarning,
      signalsBySymbol: dashboardState.signalsBySymbol,
      haltedSymbols: dashboardState.haltedSymbols,
      model: dashboardState.model,
      slPercent: dashboardState.slPercent,
      tpPercent: dashboardState.tpPercent,
    });
  }

  // ── Periodic learning cycle ────────────────────────────────────────
  async function runLearningCycle(): Promise<void> {
    // Funding P&L (spec §3.3) — independent of trade count, a position accrues
    // funding well before 3 closed trades exist to trigger the block below.
    if (useBybit && bybit?.state.connected) {
      try {
        const since = lastFundingCheckMs;
        lastFundingCheckMs = Date.now();
        const delta = await bybit.getFundingPnlSince(since);
        if (delta !== 0) {
          dashboardState.fundingPnlUsd = (dashboardState.fundingPnlUsd ?? 0) + delta;
        }
      } catch (err) {
        logger.warn(`[funding] Failed to fetch funding P&L: ${(err as Error).message}`);
      }

      // Wallet-vs-ledger sanity check (spec §8.3) — never changes cashUsd,
      // purely an early-warning signal for a shortfall the bot can't see any
      // other way (a manual withdrawal, a funding payment draining margin,
      // another manual trade on the same account).
      try {
        const balances = await bybit.getWalletBalance();
        const usdt = balances.find(b => b.coin === "USDT");
        if (usdt) {
          const available = Number.parseFloat(usdt.available);
          if (!Number.isNaN(available)) {
            const { state, warning } = checkWalletShortfall(walletMonitorState, available, portfolio.cashUsd, config.maxCapitalUsd);
            walletMonitorState = state;
            if (warning && warning !== dashboardState.walletShortfallWarning) {
              logger.warn(`[wallet] ${warning}`);
            }
            dashboardState.walletShortfallWarning = warning;
          }
        }
      } catch (err) {
        logger.warn(`[wallet] Failed to fetch wallet balance: ${(err as Error).message}`);
      }
    }

    const closedTrades = getClosedTrades(venue);
    if (closedTrades.length < 3) return;

    performanceReport = analyzePerformance(initialCash, venue);

    logger.info(`Performance: win rate ${(performanceReport.winRate * 100).toFixed(1)}% | closed trades: ${closedTrades.length}`);

    broadcast("learning", { report: performanceReport });
  }

  // ── Main timer loop ────────────────────────────────────────────────
  // Runs trading cycle + learning + UI update at refreshIntervalMs
  let bybit: BybitConnector | undefined;

  // Reentrancy guard — a live order can take several seconds to confirm
  // (see pollForFill in bybit/connector.ts), which can exceed
  // refreshIntervalMs. Without this guard, the next timer tick would start a
  // second runTradingCycle() while the first is still awaiting its order,
  // and both would read the same pre-update `portfolio` and see no open
  // position yet — silently doubling up a real entry. One tick is dropped
  // (logged, not swallowed) rather than letting cycles overlap.
  let cycleInFlight = false;
  const timer = setInterval(async () => {
    if (cycleInFlight) {
      logger.warn("[main] Skipping this tick — previous trading cycle is still in flight (likely waiting on an order fill).");
      return;
    }
    cycleInFlight = true;
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
    } finally {
      cycleInFlight = false;
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
      usePostOnlyEntries: config.usePostOnlyEntries,
      postOnlyTimeoutMs: config.postOnlyTimeoutMs,
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

    // Continuous leverage-drift + liquidation-buffer monitoring (spec §3.2/§3.4).
    // reconcilePositions()/ensureLeverageAndMargin() only run once, at connect()
    // time — this fires on every position update pushed by Bybit's private WS
    // stream (near-real-time), which is what actually catches leverage changed
    // manually mid-session or a position drifting toward liquidation.
    const liquidationBufferPercent = config.liquidationBufferPercent ?? 15;
    bybit.onRawPosition((positions: BybitPosition[]) => {
      for (const pos of positions) {
        const size = Math.abs(Number.parseFloat(pos.size));
        if (size <= 0) continue;
        const appSymbol = bybitSymbolToApp(pos.symbol);

        // Leverage drift: a direct violation of the §3.1 safety invariant that
        // the cash guardrail's notional-equals-capital-at-risk assumption
        // depends on. Escalates straight to halting entries, not just a log.
        if (pos.leverage !== "1" && !haltedSymbols.has(appSymbol)) {
          haltedSymbols.add(appSymbol);
          haltReasons.set(appSymbol, `open position at ${pos.leverage}x leverage, not the required 1x`);
          statusMessage = `🔴 ${appSymbol} leverage drifted to ${pos.leverage}x (expected 1x) — entries halted. Closes still active.`;
          logger.error(`[leverage] ${statusMessage}`);
        }

        // Liquidation buffer: even at 1x isolated, a position can still be
        // liquidated — this is independent of (and checked more often than)
        // the stop-loss logic in signals.ts, since liquidation is unforgiving.
        const markPrice = Number.parseFloat(pos.markPrice);
        const liquidationPrice = Number.parseFloat(pos.liquidationPrice);
        if (markPrice > 0 && liquidationPrice > 0) {
          const bufferPercent = (Math.abs(markPrice - liquidationPrice) / markPrice) * 100;
          if (bufferPercent <= liquidationBufferPercent && !haltedSymbols.has(appSymbol)) {
            haltedSymbols.add(appSymbol);
            haltReasons.set(appSymbol, `within ${bufferPercent.toFixed(1)}% of liquidation`);
            statusMessage = `🔴 ${appSymbol} is ${bufferPercent.toFixed(1)}% from liquidation (buffer: ${liquidationBufferPercent}%) — entries halted. Closes still active.`;
            logger.error(`[liquidation] ${statusMessage}`);
          }
        }
      }
    });

    // Real-time tickers → latestMarketData (used by the timer loop)
    bybit.onTicker((snapshots: Map<string, MarketSnapshot>) => {
      // Merge updates so we keep all symbols on the dashboard
      for (const [sym, snap] of snapshots) {
        latestMarketData.set(sym, snap);
        // Fold every tick into the 5m candle series the entry model scores
        // against. Without this the model's candle window stays empty
        // forever, scoreCandles() returns null, and the gate is silently
        // inert — it would look enabled and do nothing.
        recordTick(sym, snap.price, snap.volume24h, snap.timestamp);
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
        fundingPnlUsd: dashboardState.fundingPnlUsd,
        circuitBreakerTripped: dashboardState.circuitBreakerTripped,
        walletShortfallWarning: dashboardState.walletShortfallWarning,
      });
    });

    // Connect Bybit
    try {
      statusMessage = "connecting to Bybit...";
      render(appState);
      await bybit.connect();
      statusMessage = `Bybit ${bybit.state.mode.toUpperCase()} — ${config.symbols.length} symbols`;
      logger.info(`Bybit connected. Mode: ${bybit.state.mode}`);

      // Backfill the entry model's candle window from REST klines. Built
      // from live ticks alone it would take ~2.5h (30 x 5m bars) before the
      // model could score anything, so an enabled gate would quietly do
      // nothing for the first couple of hours of every run. Best-effort: a
      // failure here just means the gate stays inert until ticks fill the
      // window, which is the same behaviour as before, so it warns rather
      // than halting.
      if (config.useModelGate) {
        for (const bybitSymbol of bybitConfig.symbols) {
          const appSymbol = bybitSymbolToApp(bybitSymbol);
          try {
            const intervalMinutes = String(DEFAULT_INTERVAL_MS / 60000);
            const kl = await bybit.rest.getKline("linear", bybitSymbol, intervalMinutes, undefined, undefined, 100);
            // Bybit returns newest-first; the model expects chronological.
            const candles = (kl.list ?? []).map(k => ({
              openTime: Number.parseInt(k[0]!, 10),
              open: Number.parseFloat(k[1]!),
              high: Number.parseFloat(k[2]!),
              low: Number.parseFloat(k[3]!),
              close: Number.parseFloat(k[4]!),
              volume: Number.parseFloat(k[5]!),
            })).filter(c => Number.isFinite(c.close)).sort((a, b) => a.openTime - b.openTime);
            if (candles.length > 0) {
              seedCandles(appSymbol, candles);
              // Also seed the tick-price history the CLASSIC indicators read
              // (RSI/MACD/SMA/Bollinger/momentum in signals.ts). analyze()
              // is what appends to it, and since decisions moved to candle
              // closes that is once per 5m bar — so SMA(20)/Bollinger(20)
              // would need 100 minutes of uptime, momentum(10) 55, and RSI
              // 75, with every restart starting from zero. Without this the
              // strategy runs blind on default indicator values (rsi 50,
              // momentum 0, upper=middle=lower) and can never reach an
              // entry score, which is exactly what it did.
              setPriceHistory(appSymbol, {
                prices: candles.map(c => c.close),
                highs: candles.map(c => c.high),
                lows: candles.map(c => c.low),
                timestamps: candles.map(c => c.openTime),
              });
              logger.info(`[startup] OK — loaded ${candles.length} recent ${intervalMinutes}m candles for ${appSymbol}, so indicators and the model work immediately instead of needing ~2.5h of uptime first.`);
            }
          } catch (err) {
            logger.warn(`[model] Could not backfill candles for ${appSymbol} (${(err as Error).message}) — the entry gate stays inert for this symbol until live ticks fill its window.`);
          }
        }
      }

      // Pin leverage to 1x + isolated margin, verified — see spec §3.1. This is
      // what makes the cash guardrail's "notional = capital at risk" assumption
      // actually hold on a leveraged product. A failure here is NOT a case to
      // fall back to paper trading (that would silently substitute fake data
      // for a real safety problem) — it halts all new trading exactly like a
      // fatal Bybit account error, while keeping the dashboard/connection up so
      // the user can see why and existing positions keep being monitored.
      const leverageCheck = await bybit.ensureLeverageAndMargin();
      for (const d of leverageCheck.details) logger.warn(`[leverage] ${d}`);
      if (!leverageCheck.ok) {
        fatalHalt = true;
        statusMessage = `🔴 HALTED — could not confirm 1x leverage / isolated margin. See logs.`;
        logger.error(statusMessage);
        dashboardState.bybitError = statusMessage;
      } else if (leverageCheck.restrictedSymbols.length > 0) {
        // A pre-existing open position blocked the leverage change for these
        // specific symbols (see spec §3.1's second integration subtlety) — not
        // fatal, but new entries for them are unsafe until they're flat and
        // re-pinned. Reuses the same haltedSymbols mechanism as a rejected
        // live order (§6.2): closes stay fully active, only entries are blocked.
        for (const s of leverageCheck.restrictedSymbols) {
          haltedSymbols.add(s);
          haltReasons.set(s, "open position not at the required 1x leverage");
        }
        statusMessage = `⚠️ Entries restricted for ${leverageCheck.restrictedSymbols.join(", ")} — not at confirmed 1x leverage. Closes still active.`;
      }

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

      // Cross-reference any pending-order records left over from a crash
      // (spec §8.2) — more specific than the generic "unaccounted-for
      // position" warning above, since it can say "this was our own order."
      try {
        const pendingWarnings = await bybit.checkPendingOrders();
        for (const w of pendingWarnings) logger.warn(`[pending-order] ${w}`);
      } catch (err) {
        logger.warn(`[pending-order] Check skipped: ${(err as Error).message}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // A likely, specific cause for an auth failure that Bybit's own error
      // message doesn't name — see spec §7.2. testnet/mainnet API keys are
      // separate credentials; using one against the other's endpoint reads as
      // a generic auth error with nothing pointing at the actual mismatch.
      const hint = err instanceof BybitAuthError
        ? ` This can happen when a testnet API key is used for a mainnet (--live) run or vice versa — double-check config.apiKey/apiSecret were issued for the environment you're running against.`
        : "";
      statusMessage = `Bybit connection failed: ${errorMsg}.${hint} Paper mode.`;
      logger.error(`Bybit connection failed: ${errorMsg}.${hint}`);
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