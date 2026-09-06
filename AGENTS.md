# AGENTS.md — Conventions for AI Agents Working on This Repo

> **Purpose:** This document defines the contract between any AI agent (including future
> sessions of this one) and the `crypto-trader` repository. An agent that reads this file
> agrees to follow these conventions, communicates in this style, and respects these boundaries.
>
> The `blueprint` repo (the factory) has its own AGENTS.md — this file is for the product.

---

## 1. Identity & Scope

**This repo is:** `crypto-trader` — an expert-level crypto trading assistant with multi-indicator
strategy analysis, a learning system, and a real-time web dashboard. It connects to Bybit for
live market data and trade execution.

**This repo is NOT:** the factory (`blueprint`). The factory generates specs and CI-like pipelines.
The product is what lives here.

**The agent's role when working here:** Engineer, debugger, and documenter. The PM role is
defined in `blueprint/docs/roles/pm.md`.

---

## 2. Communication Style

- **Language:** English for all code, docs, commit messages, and comments. Use precise technical
  terms over metaphors.
- **Commit messages:** Follow the `<type>: <description>` convention:
  `feat:`, `fix:`, `docs:`, `sec:`, `refactor:`, `test:`, `chore:`.
  Example: `fix: Bybit WebSocket ticker handler registration`
- **Explanations:** When reporting a bug or fix, include: (1) what the symptom was, (2) what the
  root cause was, (3) how the fix works, (4) how the user can verify.
- **Ask before destructive actions:** Force push, history rewrite, mass delete, or changing
  `.gitignore` patterns that affect committed files all require explicit user consent.

---

## 3. Code Conventions

### 3.1 — Language & Runtime
- **TypeScript** (strict mode), ESM, Node 24+.
- Runtime flags: `--experimental-strip-types` for running `.ts` files directly.
- No transpilation step — the test runner and `node` handle `.ts` natively.

### 3.2 — Naming
- **Files:** `kebab-case.ts` (e.g. `bybit-integration.md`, `strategy-risk.test.ts`).
- **Directories:** `kebab-case/` (e.g. `src/strategy/`, `src/learning/`, `src/bybit/`).
- **Interfaces:** PascalCase, prefixed with `Bybit` for exchange-specific types
  (e.g. `BybitTicker`, `BybitConfig`). App types get no prefix (e.g. `Config`, `Portfolio`,
  `TradeSignal`).
- **Functions:** `camelCase` — verb-first for actions (`calcRSI`, `loadConfig`, `placeOrder`),
  noun-first for accessors (`getHistory`, `defaultParams`).
- **Classes:** PascalCase — `RestClient`, `WsClient`, `BybitConnector`.
- **Error classes:** PascalCase, suffixed with `Error` (e.g. `BybitAuthError`, `ConfigError`).

### 3.3 — Exports
- **Prefer named exports** over default exports. Every file exports its public interface
  as named exports.
- Types are exported with `export type { ... }` for type-only imports.
- Pure functions are exported directly (no class wrapper unless stateful).

### 3.4 — Testing
- **Framework:** Node built-in test runner (`node:test`) + `node:assert/strict`.
- **File naming:** `tests/<module>.test.ts` (e.g. `tests/indicators.test.ts`).
- **Import convention:** `import { ... } from "../src/<module>.ts";` (with `.ts` extension).
- **Mocking:** No mock framework. Tests use fake data, seed functions (e.g. `setHistory`),
  and `clearJournal()`/`clearHistory()` for isolation.
- **Test structure:** One `test()` per assertion. Group related tests by module.
- **Naming:** `test("module does specific thing", () => { ... })`.

### 3.5 — Error Handling
- **Custom error classes** for domain-specific failures (e.g. `BybitAuthError`,
  `BybitRateLimitError`, `ConfigError`).
- Errors are thrown, never returned as values. Callers catch and handle at the boundary.
- Error messages are descriptive and actionable: `"config.maxCapitalUsd must be a positive number"`.
- Network-level errors (timeout, DNS failure) are wrapped in `BybitConnectionError`.

### 3.6 — Imports
- All local imports use the `.ts` extension (required by Node's `--experimental-strip-types`).
- Group imports: (1) Node built-ins, (2) npm packages, (3) local modules — separated by blank lines.
- Type-only imports use `import type { ... }` syntax.

### 3.7 — Async
- `async`/`await` everywhere. No raw `.then()` chains.
- Async generators (`async function*`) for infinite streams (market data, WebSocket).
- `AbortSignal` for graceful cancellation of long-running loops.

---

## 4. Bybit Integration Conventions

### 4.1 — Module Structure
```
src/bybit/
  types.ts     — All Bybit-specific types, error classes, enums, endpoint constants
  rest.ts      — REST client (HMAC auth, rate limiting, retry)
  ws.ts        — WebSocket client (connection, heartbeat, auto-reconnect)
  connector.ts — High-level connector tying REST + WS + adapters
  adapters.ts  — Type conversion between Bybit and app types
```

### 4.2 — API Interactions
- **REST** for order placement (reliable, synchronous ack).
- **WebSocket** for real-time tickers (50-100ms) and order status updates.
- **Rate limiting:** Per-endpoint token buckets at 50% of Bybit's official limits.
  Always sync with `X-Bapi-Limit-Status` response headers.
- **Auth:** HMAC-SHA256 with payload order: `timestamp + apiKey + recvWindow + params`.
  GET uses query string, POST uses JSON body.
- **Clock sync:** `GET /v5/market/time` on startup and every hour. Auth fails if skew > 30s.

### 4.3 — WebSocket Topics
- Subscribe to `tickers.{symbol}` for each symbol in config.
- Register handlers for each specific topic (e.g. `tickers.BTCUSDT`), not generic `"ticker"`.
- Merge delta updates (Bybit omits unchanged fields). Use `lastSnapshots` cache to preserve
  previous values for missing fields.

### 4.4 — Order Quantity
- **Never hardcode** `qty: "1"`. Calculate from `positionUsd / price` for buys, or
  `existing.quantity` for sells.
- Format quantity to respect Bybit's precision rules:
  - `qty < 0.1` → 4 decimal places (e.g. BTC)
  - `qty < 1.0` → 3 decimal places (e.g. ETH)
  - `qty >= 1.0` → 2 decimal places (e.g. SOL)

---

## 5. Security Rules (Non-Negotiable)

### 5.1 — Secrets
- **NEVER** write real API keys, passwords, or tokens into code.
- **NEVER** commit `config.json`, `config.bybit.json`, `.env`, or any `.env.*` files.
- **ALWAYS** use `config.template.json` as the committed template with placeholder values.
- **ALWAYS** verify `.gitignore` before adding new files.
- **ALWAYS** `git status` + `git diff --cached` before committing.

### 5.2 — Cash Guardrail
- `maxCapitalUsd` is the user-defined operating capital. The system NEVER exceeds it.
- The system NEVER adds cash, NEVER uses credit cards, NEVER calls deposit/withdraw endpoints.
- `maxPositionSizeUsd` must be ≤ `maxCapitalUsd` (validated at startup).
- Kelly Criterion position sizing is capped by both `maxCapitalUsd` and `maxPositionSizeUsd`.

---

## 6. Architecture & Data Flow

### 6.1 — Three Pillars
```
Pillar 1 — Expert Trading Engine (src/strategy/)
  indicators.ts → signals.ts → risk.ts

Pillar 2 — Learning System (src/learning/)
  journal.ts → analyzer.ts → optimizer.ts

Pillar 3 — Real-Time Web Dashboard (src/server/)
  index.ts → public/index.html (SSE + Chart.js)
```

### 6.2 — Main Loop
- A timer runs every `config.refreshIntervalMs`:
  1. `runTradingCycle()` — evaluates signals, executes trades, journals
  2. Every 30s: `runLearningCycle()` — analyzes performance, optimizes params
  3. `updateDashboardAndUI()` — broadcasts state via SSE
- WebSocket tickers update `latestMarketData` in real-time (50-100ms) for dashboard display.
- The timer's trading cycle uses `latestMarketData` (which is the last snapshot).

### 6.3 — Bybit Connection Flow
1. Sync time (`GET /v5/market/time`)
2. Connect public WebSocket → subscribe to `tickers.{symbol}` topics
3. Connect private WebSocket → subscribe to `order`, `position`, `wallet` topics
4. On ticker: merge delta → update `latestMarketData` → broadcast dashboard
5. On order signal: calculate qty → place REST order → record in journal
6. On disconnect: auto-reconnect (exponential backoff, max 5 retries) → fallback to paper

---

## 7. Documentation Contracts

### 7.1 — Required Docs
Every new module or feature should update (or add) at least one of these:
- `docs/STRATEGY.md` — if adding/modifying trading logic or indicators
- `docs/BYBIT_INTEGRATION.md` — if adding/modifying exchange integration
- `docs/RISK_MANAGEMENT.md` — if adding/modifying risk parameters
- `docs/USER_GUIDE.md` — if adding/modifying user-facing features or dashboard
- `docs/SECURITY_PLAYBOOK.md` — if adding/modifying security measures

### 7.2 — Doc Format
- Prefer tables over prose for reference data.
- Use `mermaid` diagrams for architecture and flow.
- Include code examples for config, API calls, and CLI usage.
- Mark warnings with `⚠️` and critical rules with `🔴`.

---

## 8. Git Workflow

### 8.1 — Branching
- `main` (or `master`) is the stable branch. All commits go here.
- No feature branches unless working on a long-running experiment.

### 8.2 — Pre-Commit
- The `.githooks/pre-commit` hook runs automatically.
- It blocks commits containing `config.json`, `.env`, `*.key`, `*.pem`.
- It warns about files that may contain API keys.
- If the hook blocks a legitimate commit, use `git commit --no-verify` with a clear reason.

### 8.3 — Commit Messages
```
<type>: <imperative description, no period>

<optional body: why, not what. One blank line after subject.>
```

| Type | When |
|------|------|
| `feat` | New feature (indicator, strategy, module) |
| `fix` | Bug fix (signature error, delta handling, crash) |
| `docs` | Documentation (README, strategy guide, FAQ) |
| `sec` | Security fix or guardrail (gitignore, pre-commit, secret rotation) |
| `refactor` | Restructuring without behavior change |
| `test` | Adding or updating tests |
| `chore` | Dependencies, config, tooling |

### 8.4 — Before Every Commit
```
1. git status
2. git diff --cached --name-only
3. Check for secrets in the diff
4. npm run typecheck (must pass)
5. npm test (must pass)
6. git commit -m "<type>: <description>"
```

---

## 9. Agent Self-Check

Before the agent (this AI) declares a task complete, it must verify:

- [ ] Type-check passes (`npm run typecheck`)
- [ ] All tests pass (`npm test` — currently 81 tests)
- [ ] No secrets in any changed files
- [ ] No config.json or .env files staged
- [ ] No debug statements left in
- [ ] `.gitignore` updated if new generated files were introduced
- [ ] Documentation updated (at least one of the docs/ files)
- [ ] Commit message follows convention
- [ ] The user knows what changed and why

---

## 10. Useful Commands

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
node --experimental-strip-types src/main.ts --config ./config.json --port 3081

# Run (Bybit live — only after 100+ successful testnet trades)
node --experimental-strip-types src/main.ts --config ./config.json --live --port 3081

# Test a specific file
node --test --experimental-strip-types tests/bybit.test.ts

# Check syntax (workflow scripts reference)
node --check <file>
```