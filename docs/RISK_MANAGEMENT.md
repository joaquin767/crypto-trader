# Risk Management — Cash Guardrail & Position Sizing

> **The #1 rule: You define how much capital the system can operate with.**
> The system NEVER exceeds it. Cash is added ONLY by you, manually, in your exchange wallet.

## The Cash Guardrail (`maxCapitalUsd`)

This is the most important concept in the app.

### How It Works

```typescript
// In your config.json:
{
  "maxCapitalUsd": 1000    // ← You decide: "I want to operate with $1000"
}
```

The system's portfolio starts with exactly **$1000**. This is the **only** money the
trading engine can touch. If you have $10,000 in your exchange wallet, the remaining
$9,000 is **reserve** — the system never touches it, cannot move it, and doesn't know
it exists.

### What the System NEVER Does (Enforced by Code)

| Action | System Behavior |
|--------|----------------|
| **Adds cash** | ❌ Never. No deposit API call, no transfer. |
| **Uses credit cards** | ❌ Never. No payment endpoint. |
| **Exceeds maxCapitalUsd** | ❌ Never. Position sizing caps at the user's limit. |
| **Compounds winnings** | ❌ Never. Profits stay as cash; the cap stays the same. |
| **Operates without consent** | ❌ Never. `maxCapitalUsd` is required in config — no default. |

### Dashboard Visibility

The 🔒 **Operating Capital** card (green border) shows:
- Your defined cap (e.g., $1,000.00)
- What percentage is deployed in positions (e.g., 50% deployed)
- The number never changes — it's your hard limit

## Position Sizing (Kelly Criterion)

Once a BUY/SELL signal is generated, the system calculates position size using the
**Kelly Criterion** — a mathematical formula that maximizes long-term growth.

```
Position Size = min(
  portfolio.cashUsd × 0.9 × max(0, (confidence - 0.5) × 2),   // Kelly formula
  config.maxPositionSizeUsd                                      // User cap
)
```

### Examples

| Confidence | Kelly Fraction | Available Cash | Position Size | Notes |
|------------|---------------|----------------|--------------|-------|
| 50% | 0% | $1,000 | $0 | No trade — not confident enough |
| 70% | 40% | $1,000 | $400 | Moderate position |
| 85% | 70% | $1,000 | $500 | Capped by maxPositionSizeUsd |
| 95% | 90% | $1,000 | $500 | Capped by maxPositionSizeUsd |

## Risk Parameters (in config)

| Parameter | Example | What It Protects Against |
|-----------|---------|------------------------|
| `maxCapitalUsd` | 1000 | Total capital at risk |
| `maxPositionSizeUsd` | 500 | Per-trade loss limit |
| `maxDailyTrades` | 3 | Overtrading |
| `stopLossPercent` | 5 | Automatic exit on loss (5% drop) |
| `takeProfitPercent` | 10 | Automatic exit on profit (10% gain) |

### Choosing Safe Values

| Experience Level | maxCapitalUsd | maxPositionSize | maxDailyTrades | stopLoss |
|-----------------|---------------|-----------------|----------------|----------|
| **Beginner** | $50-100 | $25-50 | 2 | 5% |
| **Intermediate** | $500-1,000 | $200-500 | 3 | 5% |
| **Advanced** | $1,000-5,000 | $500-1,000 | 5 | 3-5% |
| **Expert** | $5,000+ | $1,000+ | 10 | 2-5% |

> ⚠️ **Never risk more than 1-2% of your total crypto portfolio per trade.**
> If your total portfolio is $10,000, set `maxPositionSizeUsd` to $200 or less.

## Deployment Ratio

The **deployment ratio** shows how much of your operating capital is in positions:

```
deploymentRatio = 1 - (cashUsd / maxCapitalUsd)

Examples:
  $0 in positions / $1,000 cap  → 0%   (all cash available)
  $500 in positions / $1,000 cap → 50%  (half deployed)
  $900 in positions / $1,000 cap → 90%  (⚠️ very concentrated)
```

**Rule of thumb:** Keep deployment below 70% to leave room for new opportunities and
to avoid over-concentration. Above 80% is a warning sign.

## Emergency Procedures

### Stop Conditions — Hit Ctrl+C if:

| Symptom | Probable Cause | Action |
|---------|---------------|--------|
| Capital down 20%+ | Strategy losing money | Stop. Review. Start with smaller capital. |
| 🔴 "10008: Common banned" | Account restricted by Bybit | Contact Bybit support immediately. |
| 🔴 "10027: Transactions banned" | Trading restricted | Contact Bybit support. |
| Multiple "10006" errors | Rate limit violation | Reduce trading frequency. |
| WebSocket reconnecting every few minutes | Network issues | Check internet stability. |
| Dashboard shows no data | Connection lost | Check if app is still running. |

### Loss Limit Strategy

The system does NOT have a hard "stop-loss on total capital." You are responsible for
monitoring the dashboard and stopping if losses exceed your comfort level.

Suggested approach:
- **Daily loss limit:** If capital drops 10% in one day, stop and review
- **Weekly loss limit:** If capital drops 20% in a week, stop and review for a week
- **Portfolio stop:** Never let losses exceed 30% of `maxCapitalUsd`

## Dashboard Monitoring Checklist

| Check | Frequency | Where | Red Flag |
|-------|-----------|-------|----------|
| Operating Capital | Every session | 🔒 Green card | Below what you started with significantly |
| Win Rate | Daily | Performance card | Below 40% after 20+ trades |
| Max Drawdown | Daily | Performance card | Above 15% |
| Deployment Ratio | Every session | Below operating capital | Above 80% |
| Learning Insights | Weekly | Insights panel | No adjustments for days (stuck) |
| Bybit Connection | Every session | Top bar | Disconnected |
| Trade History | Weekly | Trades table | Unexpected patterns |

## Files That Enforce Risk

| File | What It Enforces |
|------|-----------------|
| `src/config.ts` | Validates all risk parameters on startup |
| `src/portfolio.ts` | Updates cash/positions, enforces maxCapitalUsd |
| `src/strategy/risk.ts` | Kelly Criterion position sizing |
| `src/strategy/signals.ts` | Max daily trades check |
| `src/main.ts` | Orchestrates the trading cycle with all guards |
| `src/server/public/index.html` | Displays operating capital prominently |