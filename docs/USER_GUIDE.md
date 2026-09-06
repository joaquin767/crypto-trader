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

## Frequently Asked Questions

### When will the crypto-trader BUY a position?

The system buys only when **all** of these conditions are met simultaneously:

1. **No existing position** in that symbol (stop-loss/take-profit rules take priority)
2. **Daily trade limit not reached** (`portfolio.dailyTradeCount < config.maxDailyTrades`)
3. **Sufficient cash** available (`positionSize <= portfolio.cashUsd`)
4. **Buy score ≥ 4** AND **buy score ≥ sell score** from the indicator scoring system
5. **Kelly position > $0** (confidence must be > 50%)

The buy score is built from these indicator contributions:

| Condition | Points |
|-----------|--------|
| RSI < 30 (oversold) | +3 |
| RSI between 50-60 (neutral-bullish) | +1 |
| MACD bullish crossover | +3 |
| Price below lower Bollinger Band | +2 |
| Momentum between +2% and +15% | +2 |
| Volume surge + upward momentum | +1 |
| Price above SMA(20) (trend filter) | +1 |

**Example of a clear BUY signal:**
```
RSI: 28.3 (oversold)              → +3
MACD: bullish crossover            → +3
Price below lower Bollinger Band   → +2
Momentum: +3.2%                    → +2
Total buy score: 10 → BUY at 80% confidence
```

### Why isn't the crypto-trader buying anything?

This is the most common question. Here are all the possible reasons, ordered from most to least likely:

**1. The indicators don't agree (MOST LIKELY)**

The system requires a **buy score ≥ 4** to act. In a sideways or neutral market, the indicators
often cancel each other out. For example:
```
RSI: 52 (neutral)                  → buyScore +1
MACD: bearish divergence           → sellScore +2
Price between Bollinger Bands      → no score either way
Momentum: +0.5% (too weak)         → no score
Trend: price below SMA(20)         → sellScore +1
Total: buyScore 1 vs sellScore 3   → HOLD
```
A HOLD in a neutral market is **correct behavior** — the system is waiting for a clear signal.

**2. The daily trade limit was reached**
```
Config has maxDailyTrades: 3
Portfolio has done 3 trades today
→ All signals return HOLD with reason "maxDailyTrades reached"
```

**3. Not enough cash available**
```
maxCapitalUsd: $1,000
Cash deployed in open positions: $600
Remaining cash: $400
Kelly position size: $500
→ Insufficient cash → HOLD
```

**4. The market is too volatile**
```
ATR: 6.2% of price (exceeds 5% threshold)
→ sellScore +1, which may tip the balance against buying
```

**5. The price trend is bearish**
```
Price below SMA(20) → sellScore +1
Momentum negative → sellScore +2
→ Combined, these add 3 points to sellScore, making a buy harder
```

**6. A position is already open for that symbol**
The system won't add to an existing position. It only opens new positions in symbols
you don't currently hold. The existing position is managed via stop-loss/take-profit.

**7. The learning system has become more conservative**
If the system has been losing money, the optimizer may have raised `minBuyScore` from 4 to 5 or 6,
meaning it now requires more indicator evidence before buying. Check the "Learning Insights" panel.

**8. Confidence is too low for Kelly sizing**
```
Signal confidence: 45% (below 50% threshold)
Kelly fraction: max(0, (0.45 - 0.5) × 2) = 0
→ Position size = $0 → no trade executes
```

### How can I tell which reason is blocking the trade?

Open the dashboard and look at the **LATEST SIGNAL** section:

| Dashboard shows | Meaning |
|----------------|---------|
| `HOLD (30%) — maxDailyTrades reached` | You hit the daily limit (reason #2) |
| `HOLD (30%) — insufficient cash for BTC/USDT` | Not enough cash (reason #3) |
| `HOLD (30%) — no clear signal` | Indicators don't agree (reason #1) |
| `HOLD (30%) — RSI 52.3, MACD neutral, ...` | No strong indicator consensus |
| `HOLD (50%) — holding: 2.1% above entry` | Position already open (reason #6) |
| No signal at all on the dashboard | Check that the app is running and receiving market data |

### What makes a "good" buying opportunity?

The best buying opportunities happen when multiple indicators align:

```
✅ RSI < 30 (oversold)          → "Cheap" entry
✅ MACD bullish crossover       → Momentum turning up
✅ Price below lower band       → Statistical oversold
✅ Positive momentum            → Short-term strength
✅ Price above SMA(20)          → Medium-term uptrend
✅ Volume surge                 → Confirmation
```

This combination produces a buy score of 12+ and confidence > 80%.

### Why did the system SELL instead of HOLD?

The system sells for these reasons:

| Reason | Condition | Confidence |
|--------|-----------|------------|
| **Stop-loss** | Price dropped below `stopLossPercent` | 80-90% |
| **Take-profit** | Price rose above `takeProfitPercent` | 80-90% |
| **Expert exit** | RSI > 70 AND price above upper Bollinger Band | 75% |
| **Indicator sell** | sellScore ≥ 4 AND sellScore > buyScore | 40-95% |

### Why does the system sometimes do nothing for hours?

In a flat or range-bound market, the indicators produce conflicting signals. The system
is designed to **wait** rather than force a trade. This is a feature, not a bug — it
prevents overtrading in uncertain conditions.

The dashboard will show `HOLD` with reasons like "no clear signal" or "RSI 52.3, MACD neutral"
during these periods. The system is still working — it's just waiting for a statistically
significant opportunity.

### How long should I wait before seeing a trade?

In a trending market (strong up or down moves), you should see a trade within 30-60 minutes.
In a sideways market, it could take hours or even days. The learning system also needs at
least 20-30 trades to start optimizing meaningfully.

### Does the system trade every symbol simultaneously?

It evaluates every symbol in your config, but it only opens a position if the conditions
are met. It's common for only 1-2 of 3 symbols to have active signals at any given time.
The system does NOT open multiple positions in the same symbol.

### Can I force the system to trade?

No. There is no manual override. The system is designed to be conservative: it waits for
statistical evidence before committing capital. If you want to trade manually, you should
do it directly on the exchange, not through this app.

### What if I want to change the strategy aggressiveness?

Adjust these config parameters:

| To be more aggressive... | Decrease | Increase |
|--------------------------|----------|----------|
| Trade more often | `maxDailyTrades` | — |
| Risk more per trade | — | `maxPositionSizeUsd` |
| Stay in trades longer | `stopLossPercent` | `takeProfitPercent` |
| Take profits sooner | — | `takeProfitPercent` |
| Use more capital | `maxCapitalUsd` | — |

Changes take effect on the next restart.