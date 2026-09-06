# Bybit Integration — Live & Testnet Trading

This document explains how to connect the crypto-trader to the Bybit exchange for live
market data and trade execution.

## Architecture: WebSocket + REST Hybrid

```
                 ┌─────────────────────────────────┐
                 │        main.ts LOOP             │
                 │  (timer every refreshIntervalMs) │
                 └──────────┬──────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
    ┌──────────────┐ ┌────────────┐ ┌──────────────┐
    │ Bybit WS     │ │ Bybit REST │ │ Bybit WS     │
    │ PUBLIC       │ │            │ │ PRIVATE      │
    │              │ │            │ │              │
    │ tickers      │ │ placeOrder │ │ order events │
    │ 50-100ms     │ │ cancel     │ │ position     │
    │ kline        │ │ history    │ │ wallet       │
    │ orderbook    │ │ balance    │ │              │
    └──────────────┘ └────────────┘ └──────────────┘
```

- **WebSocket Public** — Real-time tickers at 50-100ms. Updates the dashboard instantly.
- **REST API** — Order placement (reliable acknowledgement, max 2 orders/second).
- **WebSocket Private** — Order status updates, position changes, wallet balance changes.

## API Credentials Setup

### Step 1: Create Bybit Account

- **Testnet:** https://testnet.bybit.com (no real money, separate from mainnet)
- **Mainnet:** https://www.bybit.com (real money)

### Step 2: Create API Key

1. Go to **API Management** in your Bybit account settings
2. Click **Create New Key**
3. Select **API Transaction** (to allow trading)
4. Set permissions:
   - ✅ **Read** — for market data
   - ✅ **Trade** — for placing orders
   - ❌ **Withdraw** — NEVER enable this for API keys
   - ❌ **Transfer** — NEVER enable this
5. **IP Whitelist** — Add your server's IP address (recommended) or leave unrestricted (less secure)

### Step 3: Save Credentials

Save your **API Key** and **API Secret** immediately. Bybit will not show the secret again.

## Configuration

### Testnet (safe, recommended first)

```json
{
  "exchange": "bybit",
  "apiKey": "YOUR_TESTNET_API_KEY",
  "apiSecret": "YOUR_TESTNET_API_SECRET",
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "maxCapitalUsd": 50,
  "maxPositionSizeUsd": 25,
  "maxDailyTrades": 3,
  "stopLossPercent": 5,
  "takeProfitPercent": 10,
  "refreshIntervalMs": 3000
}
```

> **Note:** Bybit uses `BTCUSDT` format (no `/`). The adapter converts automatically.

### Mainnet (real money)

```json
{
  "exchange": "bybit",
  "apiKey": "YOUR_MAINNET_API_KEY",
  "apiSecret": "YOUR_MAINNET_API_SECRET",
  "maxCapitalUsd": 50,
  "maxPositionSizeUsd": 25,
  "maxDailyTrades": 3,
  "stopLossPercent": 5,
  "takeProfitPercent": 10,
  "refreshIntervalMs": 3000
}
```

⚠️ **Mainnet safety rules:**
- Start with `maxCapitalUsd: 50` — only increase after 50+ profitable trades
- Never run on a Friday night (low liquidity)
- Never change config while the system is running

## Connection Lifecycle

| Event | What happens |
|-------|-------------|
| **Startup** | Time sync via `GET /v5/market/time`, then WebSocket connect |
| **Connected** | Dashboard shows 🟢 **Bybit TESTNET connected** |
| **Ticker received** | Dashboard updates prices within 100ms |
| **Trading cycle** | Every `refreshIntervalMs`, evaluates signals, executes via REST |
| **Order filled** | `order` event via private WebSocket confirms the trade |
| **Disconnected** | Dashboard shows ⚪ **Bybit Offline** in yellow, auto-reconnect starts |
| **Reconnect** | Exponential backoff: 1s → 2s → 4s → 8s → 16s (max 5 retries) |
| **Fallback** | After 5 failed reconnects, switches to paper simulation until reconnect |

## Rate Limits (Anti-Ban)

The system enforces these limits automatically. See `src/bybit/types.ts` for exact values.

| Endpoint | Our Limit | Bybit Limit | Safety Margin |
|----------|-----------|-------------|---------------|
| Place Order | 2/s | 10/s | 80% headroom |
| Cancel Order | 2/s | 10/s | 80% headroom |
| Wallet Balance | 5/s | 50/s | 90% headroom |
| Tickers (REST) | 10/s | 50/s (shared) | 80% headroom |
| **HTTP IP limit** | 120/s | 600/5s (120/s) | 0% — exact match |

### What happens if you hit a limit

| Status Code | Meaning | System Response |
|-------------|---------|----------------|
| `retCode 10006` | API rate limit | Backoff 2s, retry. Reduce rate by 50%. |
| `HTTP 403` | IP banned | Wait 30s, retry. If persists, switch to paper mode. |
| `HTTP 429` | System protection | Wait 5s, retry. Reduce all rates by 75%. |

## Security Best Practices

1. **Use separate API keys** for testnet and mainnet
2. **IP whitelist** your server IP in Bybit API settings
3. **Withdraw permission OFF** — the system never withdraws, so don't enable it
4. **Transfer permission OFF** — the system never transfers funds
5. **Start small** — `maxCapitalUsd: 50` is a safe starting point
6. **Monitor daily** — check the dashboard for anomalies
7. **Never share API secrets** — not in code, not in config files committed to git

## Troubleshooting

| Problem | Likely Cause | Solution |
|---------|-------------|----------|
| ❌ "API key is invalid" | Wrong key or wrong environment | Check testnet vs mainnet URL |
| ❌ "Signature error" | Clock skew > 30s | Run `GET /v5/market/time` and check your system clock |
| ❌ "Permission denied" | API key missing Trade permission | Edit API key in Bybit settings |
| ❌ "IP not whitelisted" | Your IP isn't in the whitelist | Add your IP or disable whitelist |
| ❌ "10006 rate limit" | Too many requests | Config too aggressive, reduce trades |
| ❌ WebSocket keeps disconnecting | Network/firewall issue | Check ping to stream.bybit.com |
| ❌ No tickers on dashboard | WebSocket not subscribed | Check symbols in config (Bybit format: BTCUSDT) |