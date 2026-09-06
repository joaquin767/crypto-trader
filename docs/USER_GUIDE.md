# User Guide — How to Use the Crypto Trader

## Dashboard Layout

```
┌────────────────────────────────────────────────────────────┐
│  📊 Crypto Trader                    [PAPER]  ⚪ Bybit Off │
├────────────┬────────────┬────────────┬──────────────────────┤
│ Portfolio  │ 🔒 Operating│ Cash       │ Win Rate            │
│ Value      │ Capital    │ $999.00    │ 50%                 │
│ $14,100    │ $1,000.00  │            │                     │
├────────────┴──────┬─────┴────────────┴──────────────────────┤
│ Total P&L │ Sharpe  │ Profit Factor │ Max Drawdown         │
│ +$41.50   │ 0.82    │ 1.5           │ 2.1%                 │
├───────────────────┴─────────────────────────────────────────┤
│ 📈 Market                                                    │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                      │
│ │ BTC/USDT │ │ ETH/USDT │ │ SOL/USDT │                      │
│ │ $41,398  │ │ $3,200   │ │ $115     │                      │
│ │ ↑ 4.6%   │ │ ↑ 3.2%   │ │ ↓ -2.1%  │                      │
│ └──────────┘ └──────────┘ └──────────┘                      │
├─────────────────────────────────────────────────────────────┤
│ 📉 Equity Curve (Chart.js line chart)                        │
├────────────────────────────┬────────────────────────────────┤
│ 🔄 Recent Trades           │ 🧠 Learning Insights           │
│ Time  │Sym │Side│P&L│Conf  │ ◆ minBuyScore 4→5 (win 33%)   │
│ 12:00 │BTC │ BUY│—  │80%   │ ◆ volatility 5→4.5%          │
├────────────────────────────┴────────────────────────────────┤
│ Strategy Params: RSI oversold:30 · overbought:70 · min:4    │
├─────────────────────────────────────────────────────────────┤
│ 🟢 Status: PAPER | buy BTC/USDT @ $41,398                    │
└─────────────────────────────────────────────────────────────┘
```

## Understanding the Cards

### 🟢 Portfolio Value
Your total assets (cash + open positions value). **Green** = profitable overall, **Red** = losing.

### 🔒 Operating Capital
The **crucial number**. This is the `maxCapitalUsd` you set in config — the system NEVER exceeds this. If it goes down, you're losing money. If it goes up, you're making money. This is what you should watch.

### 📈 Market Cards
Each watched symbol shows:
- **Price** — current last price
- **Change %** — 24h change with arrow (↑/↓)
- **Color** — Green (>2%), Yellow (±2%), Red (<-2%)

### 📉 Equity Curve
The portfolio value over time. A rising line = profit, falling = losses.

## Interpreting Trade Signals

The system generates three types of signals:

| Signal | Color | What It Means | What Happens |
|--------|-------|---------------|--------------|
| **BUY** | 🟢 Green | Strong indicator consensus to enter | Places a market buy order |
| **SELL** | 🔴 Red | Stop-loss, take-profit, or indicator exit | Places a market sell order |
| **HOLD** | 🟡 Yellow | No clear signal or waiting for confirmation | No action |

Each signal shows:
- **Confidence** — 0-100% (how sure the system is)
- **Reason** — which indicators drove the decision (e.g. "RSI oversold (28.3); MACD bullish crossover")
- **Indicators** — the exact RSI, MACD, momentum, and ATR at decision time

## Monitoring Your Risk

### Check These Every Session

| What | Where | Warning Sign |
|------|-------|--------------|
| **Operating Capital** | 🔒 Green card | Dropping below what you set |
| **Win Rate** | Performance card | Below 40% after 20+ trades |
| **Max Drawdown** | Performance card | Above 15% |
| **Deployment Ratio** | Below operating capital | Above 80% (too much risk) |
| **Learning Insights** | Insights panel | System should be adapting |
| **Bybit Connection** | Top bar (if live) | Disconnected warning |

### The Four Risk Rules (enforced by code)

1. **maxCapitalUsd** — The system operates with EXACTLY what you define. No more.
2. **maxPositionSizeUsd** — Per-trade risk capped.
3. **maxDailyTrades** — Prevents overtrading.
4. **stopLossPercent / takeProfitPercent** — Automatic exit thresholds.

## Learning System

The optimizer runs every 30 seconds. When it adjusts parameters, you'll see **Learning Insights**:

```
◆ minBuyScore 4→5 (win rate 33% < 40%)
◆ volatilityCap 5→4.5% (avg loss > avg win)
◆ RSI oversold 30→28 (tightening entry)
```

These are the system learning from its mistakes. If you see the same insight repeating, the strategy is stable. If you see constant changes, the strategy hasn't converged yet.

## Keyboard Controls

| Key | Action |
|-----|--------|
| **Ctrl+C** | Graceful shutdown (saves nothing — journal is in-memory) |
| **q** | Applies in terminal mode only |

## When to Stop

🚨 **Emergency stop conditions** — hit Ctrl+C and investigate:

- **Capital down 20%+** from starting value → the strategy is losing more than it should
- **WebSocket repeatedly disconnecting** → network issue or rate limit problem
- **Rate limit errors (10006) appearing** → configuration too aggressive
- **Bybit connection error (10008, 10027)** → account issue, contact Bybit

## Best Practices

1. **Start small.** Use `maxCapitalUsd: 50` for your first week.
2. **Let it run.** The learning system needs at least 20-30 trades to start optimizing.
3. **Review insights weekly.** Are the parameter changes sensible?
4. **Don't change config mid-session.** Stop, change, restart.
5. **Monitor daily.** Check the dashboard for at least 5 minutes each day.
6. **Never invest what you can't lose.** Crypto trading is risky.