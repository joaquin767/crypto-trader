# crypto-trader v2 — Expert Trading Engine

An **expert-level** crypto trading assistant with multi-indicator strategy analysis, a
**learning system** that improves from experience, and a **real-time web dashboard**.

Built by the **blueprint app factory** (spec: `blueprint/specs/crypto-trader.md`).
Repository: https://github.com/joaquin767/crypto-trader

## Features

- **🚀 Live trading** — real-time Bybit WebSocket tickers (50-100ms) + REST order execution via the Bybit V5 API
- **📊 Expert trading engine** — evaluates RSI, MACD, Bollinger Bands, SMA, ATR, momentum, and volume before every trade
- **💰 Kelly Criterion position sizing** — mathematical position sizing that scales with confidence
- **🧠 Learning from mistakes** — tracks every trade, analyzes performance (win rate, Sharpe, drawdown), and automatically adjusts strategy parameters
- **📈 Real-time web dashboard** — live SSE streaming with portfolio, market data, charts, trade history, and learning insights
- **🔒 User-defined operating capital** — the system NEVER exceeds your `maxCapitalUsd`
- **🛡️ Anti-ban rate limiting** — per-endpoint token buckets with 50% safety margin
- **📝 Paper trading by default** — no real money unless `--live` flag

## Quick start

```bash
npm install --cache ./.npm-cache
npm run verify              # tsc --noEmit && node --test (81 tests)

# Paper trading with web dashboard:
npm run dashboard
# Open http://localhost:3081

# Terminal only:
npm run start
```

## Documentation

| Document | What it covers |
|----------|---------------|
| **[SETUP.md](docs/SETUP.md)** | Installation, configuration, running the app |
| **[USER_GUIDE.md](docs/USER_GUIDE.md)** | Dashboard walkthrough, interpreting signals, monitoring risk, **FAQ** |
| **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** | The three pillars: Trading Engine, Learning System, Web Dashboard |
| **[STRATEGY.md](docs/STRATEGY.md)** | Full indicator reference, scoring rules, learning optimizer |
| **[RISK_MANAGEMENT.md](docs/RISK_MANAGEMENT.md)** | Cash guardrail, Kelly Criterion, risk params, emergency procedures |
| **[BYBIT_INTEGRATION.md](docs/BYBIT_INTEGRATION.md)** | Bybit API setup, WebSocket+REST hybrid, rate limits, security |

## Project Structure

```
src/
├── config.ts              # Config loader (validates all risk params)
├── market.ts              # Simulated market data feed
├── portfolio.ts           # Portfolio with cash guardrail (maxCapitalUsd)
├── executor.ts            # Paper trade executor
├── tui.ts                 # Terminal UI fallback
├── main.ts                # Entry point — wires everything
├── strategy/
│   ├── indicators.ts      # RSI, MACD, SMA, Bollinger, ATR, momentum
│   ├── signals.ts         # Multi-indicator scoring + decision logic
│   └── risk.ts            # Kelly Criterion, Sharpe, drawdown
├── learning/
│   ├── journal.ts         # Trade journal (every trade recorded with context)
│   ├── analyzer.ts        # Performance metrics (win rate, profit factor)
│   └── optimizer.ts       # Parameter optimizer (learns from results)
├── bybit/
│   ├── types.ts           # Bybit V5 types, error classes, rate limits
│   ├── rest.ts            # REST client (HMAC-SHA256, token bucket)
│   ├── ws.ts              # WebSocket client (auto-reconnect, heartbeat)
│   ├── connector.ts       # Connector — ties REST + WS + adapters
│   └── adapters.ts        # Symbol conversion, ticker/order parsing
├── server/
│   ├── index.ts           # Hono HTTP server with SSE streaming
│   └── public/
│       └── index.html     # Web dashboard (Chart.js, dark theme)
└── tests/                 # 81 tests
```

## Quick Reference

```bash
# Install
npm install --cache ./.npm-cache

# Verify
npm run verify

# Run (paper, dashboard)
npm run dashboard

# Run (paper, terminal only)
npm run start

# Run (Bybit testnet)
# Edit config.json with testnet API keys, then:
npm run dashboard

# Run (Bybit live)
# Edit config.json with mainnet API keys, add --live flag:
node --experimental-strip-types src/main.ts --config ./config.json --live --port 3081
```

## Test Results

| Suite | Count | Status |
|-------|-------|--------|
| Config validation | 6 | ✅ |
| Technical indicators | 9 | ✅ |
| Signal generation | 5 | ✅ |
| Strategy risk | 9 | ✅ |
| Portfolio operations | 5 | ✅ |
| Executor | 3 | ✅ |
| Trade journal | 5 | ✅ |
| Learning analyzer | 7 | ✅ |
| Bybit types & adapters | 18 | ✅ |
| Integration | 6 | ✅ |
| TUI | 2 | ✅ |
| **Total** | **81** | ✅ |

## License

MIT