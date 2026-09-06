# Setup Guide — crypto-trader

## Prerequisites

- **Node.js 24+** (check with `node --version`)
- **npm** (comes with Node.js)
- A **Bybit account** (optional, for live trading)
- **Git** (to clone the repo)

## Installation

```bash
# Clone the repo
git clone git@github.com:joaquin767/crypto-trader.git
cd crypto-trader

# Install dependencies (use workspace-local cache — ~/.npm is read-only in DSH)
npm install --cache ./.npm-cache

# Verify everything works
npm run verify
# Expected output: 81 tests passing, typecheck clean
```

## Configuration

### Paper Trading (no API keys needed)

A demo config is ready at `config.json`:

```json
{
  "exchange": "binance",
  "apiKey": "paper-trading-demo-key",
  "apiSecret": "paper-trading-demo-secret",
  "symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
  "maxCapitalUsd": 1000,
  "maxPositionSizeUsd": 500,
  "maxDailyTrades": 3,
  "stopLossPercent": 5,
  "takeProfitPercent": 10,
  "refreshIntervalMs": 2000
}
```

### Bybit Testnet (no real money)

Copy the template and fill in your keys:

```bash
cp config.bybit.json config.json
```

Edit `config.json`:

```json
{
  "exchange": "bybit",
  "apiKey": "YOUR_TESTNET_API_KEY",
  "apiSecret": "YOUR_TESTNET_API_SECRET",
  "symbols": ["BTC/USDT", "ETH/USDT"],
  "maxCapitalUsd": 50,
  "maxPositionSizeUsd": 25,
  "maxDailyTrades": 3,
  "stopLossPercent": 5,
  "takeProfitPercent": 10,
  "refreshIntervalMs": 3000
}
```

> ⚠️ **Always start in testnet mode.** The system treats any config without `--live` as testnet/paper.

### Bybit Mainnet (real money)

Only after 100+ successful testnet trades:

1. Create **mainnet** API keys (separate from testnet!)
2. Start with a very small `maxCapitalUsd` (e.g. $50)
3. **Never use more capital than you're willing to lose**

## Running

```bash
# Terminal + web dashboard (recommended):
npm run dashboard
# Open http://localhost:3081

# Terminal only:
npm run start

# Custom port:
node --experimental-strip-types src/main.ts --config ./config.json --port 9090
```

## Verifying It Works

1. Start the app
2. Open http://localhost:3081
3. You should see:
   - Market cards for BTC, ETH, SOL with live prices
   - Portfolio showing your operating capital
   - The status bar showing "PAPER | ..."
   - Trade signals appearing as the system analyzes market data