# crypto-trader

A terminal-based crypto trading assistant built by the **blueprint app factory**
(spec: `blueprint/specs/crypto-trader.md`).

Monitors market conditions, suggests trades based on configurable risk thresholds,
and executes them through a connected exchange API (paper trading by default).

## Quick start
```sh
npm install --cache ./.npm-cache
npm run verify              # tsc --noEmit && node --test

# Create a config.json (see src/config.ts for the shape)
# Then run (paper mode):
node --experimental-strip-types src/main.ts --config ./config.json
```

## Layout
- `src/config.ts` — load & validate user config
- `src/market.ts` — real-time market data via ccxt
- `src/risk.ts` — score trade ideas against risk thresholds
- `src/portfolio.ts` — track holdings and P&L
- `src/executor.ts` — execute trades via ccxt
- `src/tui.ts` — terminal dashboard using blessed/blessed-contrib
- `src/main.ts` — entry point
- `tests/` — per-component + integration tests