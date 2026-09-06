# Strategy Reference — How the Trading Engine Works

This document explains every aspect of the trading strategy: the indicators, the
scoring system, the risk management, and the learning optimizer.

## 1. Technical Indicators

Six indicators are calculated on every evaluation cycle. They are all **pure functions**
in `src/strategy/indicators.ts`.

### RSI — Relative Strength Index (14-period)

**What it measures:** Whether an asset is overbought or oversold.

```
Formula: RSI = 100 - (100 / (1 + avgGain / avgLoss))
Range: 0-100
Interpretation:
  < 30   → Oversold   (potential buy)
  > 70   → Overbought (potential sell)
```

### MACD — Moving Average Convergence/Divergence (12, 26, 9)

**What it measures:** Trend direction and momentum changes.

```
Components:
  MACD Line   = EMA(12) - EMA(26)
  Signal Line = SMA of last 9 MACD values
  Histogram   = MACD Line - Signal Line
  Bullish     = MACD crossed above Signal Line
```

### Bollinger Bands (20-period, 2σ)

**What it measures:** Volatility and price extremes.

```
Bands:
  Middle = SMA(20)
  Upper  = SMA(20) + 2 × StdDev
  Lower  = SMA(20) - 2 × StdDev
  Width  = (Upper - Lower) / Middle  (bandwidth %)

Interpretation:
  Price < Lower → oversold (buy signal)
  Price > Upper → overbought (sell signal)
  Width > 0.5  → high volatility
```

### SMA — Simple Moving Average (20-period)

**What it measures:** Trend baseline.

```
Formula: SMA(20) = sum of last 20 prices / 20
Used as: Trend filter — price above = bullish, below = bearish
```

### ATR — Average True Range (14-period)

**What it measures:** Market volatility in price units.

```
TR = max(high - low, |high - prevClose|, |low - prevClose|)
ATR = average of last 14 TR values
Used as: Volatility check — ATR > 5% of price = avoid trading
```

### Momentum (10-period)

**What it measures:** Short-term price velocity.

```
Formula: ((currentPrice - price10BarsAgo) / price10BarsAgo) × 100
Range: -100% to +∞ (percentage change over 10 bars)
```

## 2. Signal Generation (src/strategy/signals.ts)

The signal generator combines all 6 indicators into a **scored consensus**:

### Scoring Rules

| Condition | Score Change | Rationale |
|-----------|-------------|-----------|
| RSI < 30 (oversold) | buyScore += 3 | Classic buy signal |
| RSI 50-60 (neutral-bullish) | buyScore += 1 | Mild bullish |
| RSI > 70 (overbought) | sellScore += 3 | Classic sell signal |
| MACD bullish crossover | buyScore += 3 | Trend turning up |
| MACD bearish divergence | sellScore += 2 | Trend weakening |
| Price < lower Bollinger Band | buyScore += 2 | Oversold by volatility |
| Price > upper Bollinger Band | sellScore += 2 | Overbought by volatility |
| Momentum +2% to +15% | buyScore += 2 | Healthy upward trend |
| Momentum < -5% | sellScore += 2 | Strong downtrend |
| Volume surge (>500) + up momentum | buyScore += 1 | Volume confirms uptrend |
| Volume surge + down momentum | sellScore += 1 | Volume confirms downtrend |
| Price > SMA(20) | buyScore += 1 | Above trend = bullish |
| Price < SMA(20) | sellScore += 1 | Below trend = bearish |
| ATR > 5% of price | sellScore += 1 | Too volatile, avoid |

### Decision Logic

```typescript
if (buyScore >= 4 && buyScore >= sellScore) → BUY
  confidence = min(0.95, 0.4 + buyScore × 0.1)

if (sellScore > buyScore && sellScore >= 4) → SELL
  confidence = min(0.95, 0.4 + sellScore × 0.1)

otherwise → HOLD
  confidence = 0.3
```

### Position Override

If a position already exists:
- **Stop-loss:** Price drops below `stopLossPercent` → immediate SELL with high confidence
- **Take-profit:** Price rises above `takeProfitPercent` → immediate SELL with high confidence
- **RSI overbought + price above upper band** → expert exit SELL at 75% confidence

## 3. Risk Management (src/strategy/risk.ts)

### Kelly Criterion Position Sizing

The optimal bet size is calculated mathematically:

```
Kelly Fraction = max(0, (confidence - 0.5) × 2)
  → confidence 0.50 = 0%     (no trade)
  → confidence 0.75 = 50%    (half of available cash)
  → confidence 1.00 = 100%   (all capped)

Position Size = min(
  availableCash × 0.9 × kellyFraction,   // Kelly-optimal (10% reserve for fees)
  config.maxPositionSizeUsd               // User-defined per-trade limit
)
```

### Performance Metrics

| Metric | Formula | What It Means |
|--------|---------|---------------|
| **Win Rate** | wins / total | Fraction of profitable trades |
| **Total P&L** | Σ all trade P&Ls | Net profit/loss |
| **Sharpe Ratio** | avg(return) / std(return) × √365 | Risk-adjusted return (>1 = good) |
| **Profit Factor** | grossProfit / grossLoss | USD earned per USD lost (>1.5 = good) |
| **Max Drawdown** | (peak - trough) / peak × 100 | Worst decline from peak |

## 4. Learning Optimizer (src/learning/optimizer.ts)

### Adjustable Parameters

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `rsiOversoldThreshold` | 30 | 25-35 | Lower = only extreme oversold triggers buys |
| `rsiOverboughtThreshold` | 70 | 70-78 | Higher = only extreme overbought triggers sells |
| `minBuyScore` | 4 | 4-6 | Higher = more evidence needed before buying |
| `volatilityCap` | 5% | 3-5% | Lower = avoid more volatile markets |

### Learning Rules (run every 30 seconds)

| If... | Then... | Why |
|-------|---------|-----|
| Win rate < 40% AND ≥5 trades | `minBuyScore++`, `rsiOversoldThreshold -= 2` | "I'm losing too often — be more selective" |
| Win rate > 65% AND 5-20 trades | `rsiOversoldThreshold += 2` | "I'm doing well — cautiously expand" |
| Avg loss > avg win × 1.5 | `volatilityCap -= 0.5` | "Losses too big — avoid volatile markets" |
| Max drawdown > 15% | `rsiOverboughtThreshold += 2` | "Too much drawdown — exit sooner" |

### Learning Insights

Every adjustment is recorded and shown on the dashboard:

```
◆ minBuyScore 4→5 (win rate 33% < 40%)
◆ rsiOversold 30→28 (tightening entry conditions)
◆ volatilityCap 5→4.5% (avg loss > avg win)
```

## 5. Complete Decision Flow

```
Market Data (ticker or simulated)
        │
        ▼
Calculate 6 Indicators (src/strategy/indicators.ts)
  rsi = calcRSI(prices, 14)
  macd = calcMACD(prices)
  bollinger = calcBollinger(prices, 20, 2)
  sma = calcSMA(prices, 20)
  atr = calcATR(highs, lows, closes, 14)
  momentum = calcMomentum(prices, 10)
        │
        ▼
Score & Decide (src/strategy/signals.ts)
  buyScore = 0, sellScore = 0
  Apply scoring rules → add to buyScore or sellScore
        │
        ▼
Existing position? ──Yes──→ Check stop-loss / take-profit / RSI exit
        │                         │
        No                         ▼
        │                    SELL signal
        ▼
buyScore >= 4? sellScore >= 4?
        │
        ▼
TradeSignal { type, confidence, reason, indicators }
        │
        ▼
Position Size (src/strategy/risk.ts)
  Kelly Fraction = max(0, (confidence - 0.5) × 2)
  Position $ = min(availableCash × 0.9 × kelly, maxPositionSizeUsd)
        │
        ▼
Execute (src/executor.ts or src/bybit/rest.ts)
  → TradeResult { side, price, quantity, fee }
        │
        ▼
Journal (src/learning/journal.ts)
  recordEntry() or recordExit()
        │
        ▼
Dashboard (src/server/)
  broadcast("trade", { ... })
```