# crypto-trader v2 — Expert Trading Engine

An **expert-level** crypto trading assistant with multi-indicator strategy analysis, a
**learning system** that improves from experience, and a **real-time web dashboard**.

Built by the **blueprint app factory** (spec: `blueprint/specs/crypto-trader.md`).

## Features
- **Live trading** — real-time Bybit WebSocket tickers (50-100ms) + REST order execution via the Bybit V5 API
- **Expert trading engine** — evaluates RSI, MACD, Bollinger Bands, SMA, ATR, momentum, and volume before every trade
- **Kelly Criterion position sizing** — mathematical position sizing that scales with confidence
- **Learning from mistakes** — tracks every trade, analyzes performance (win rate, Sharpe, drawdown), and automatically adjusts strategy parameters
- **Real-time web dashboard** — live SSE streaming with portfolio, market data, charts, trade history, and learning insights
- **Paper trading by default** — no real money unless `--live` flag

## Quick start
```sh
npm install --cache ./.npm-cache
npm run verify              # tsc --noEmit && node --test (63 tests)

# Paper trading with web dashboard:
npm run dashboard
# Open http://localhost:3081 in your browser

# Or without dashboard (terminal only):
node --experimental-strip-types src/main.ts --config ./config.json
```

## Layout
| Path | Purpose |
|---|---|
| `src/config.ts` | Load & validate user config |
| `src/market.ts` | Real-time market data feed (paper simulation) |
| `src/strategy/indicators.ts` | Technical indicators: RSI, MACD, SMA, EMA, Bollinger, ATR, momentum |
| `src/strategy/signals.ts` | Combines indicators into scored trade decisions |
| `src/strategy/risk.ts` | Kelly Criterion position sizing, drawdown, Sharpe, profit factor |
| `src/learning/journal.ts` | Trade journal (records every entry/exit with context) |
| `src/learning/analyzer.ts` | Performance analysis: win rate, Sharpe, drawdown, etc. |
| `src/learning/optimizer.ts` | Strategy parameter optimizer (learns from results) |
| `src/portfolio.ts` | Track holdings and P&L |
| `src/executor.ts` | Execute trades (paper or live via ccxt) |
| `src/server/index.ts` | Hono HTTP server with SSE real-time streaming |
| `src/server/public/index.html` | Web dashboard (Chart.js, dark theme) |
| `src/tui.ts` | Terminal fallback renderer |
| `tests/` | 63 tests across all modules |

## Web Dashboard
When running with `npm run dashboard`, open `http://localhost:3081` to see:
- Portfolio value, cash, open positions, win rate in real-time
- Market data with color-coded indicators (green/yellow/red)
- Equity curve chart
- Recent trade history
- Learning insights (what the system adjusted and why)
- Current strategy parameters

## Learning System
The optimizer runs every 30 seconds and adjusts strategy parameters based on performance:
- Low win rate (< 40%) → becomes more selective (raises minBuyScore)
- High drawdown (> 15%) → tightens exit thresholds
- Large losses relative to wins → reduces volatility tolerance
- Strong results → cautiously expands opportunity window

All adjustments are logged as "learning insights" visible on the dashboard.