// Wallet balance monitoring — see specs/live-trading-readiness.md §8.3.
//
// dashboardState.walletTotalUsd was fetched once at startup and never
// reconciled again — display-only, by design (cashUsd is never derived from
// the exchange wallet, see adapters.ts's walletToTotalUsd). But with nothing
// periodically checking it, the user had zero automated warning if the real
// account balance could no longer support what the bot believes its
// operating capital is (a manual withdrawal, a funding payment draining
// margin, another manual trade on the same account). This never changes
// cashUsd — purely an early-warning signal, exactly like the design intent
// it's extending.

export interface WalletMonitorState {
  shortfallStreak: number;
  warningActive: boolean;
}

export function createWalletMonitorState(): WalletMonitorState {
  return { shortfallStreak: 0, warningActive: false };
}

/**
 * Compare Bybit's real available USDT balance against what the bot's local
 * ledger believes its uncommitted cash is. A single noisy check (a funding
 * settlement mid-flight, a rounding blip) shouldn't trigger a warning — only
 * a shortfall sustained across `requiredConsecutive` checks does, but once
 * triggered the warning stays visible every check until the shortfall
 * actually clears (no hysteresis needed on the way back down — recovering is
 * safe to trust immediately).
 */
export function checkWalletShortfall(
  state: WalletMonitorState,
  availableUsdt: number,
  portfolioCashUsd: number,
  maxCapitalUsd: number,
  requiredConsecutive: number = 3,
): { state: WalletMonitorState; warning: string | null } {
  // "Material" — ignore noise for tiny accounts or rounding-level differences.
  const tolerance = Math.max(1, maxCapitalUsd * 0.05);
  const shortfall = portfolioCashUsd - availableUsdt;

  if (shortfall <= tolerance) {
    return { state: createWalletMonitorState(), warning: null };
  }

  const shortfallStreak = state.shortfallStreak + 1;
  const warningActive = state.warningActive || shortfallStreak >= requiredConsecutive;
  const warning = warningActive
    ? `⚠️ Bybit available balance ($${availableUsdt.toFixed(2)}) is $${shortfall.toFixed(2)} below what the bot believes it has ($${portfolioCashUsd.toFixed(2)}) — check for a manual withdrawal, funding payment, or other trade on this account. cashUsd is unaffected; this is informational only.`
    : null;

  return { state: { shortfallStreak, warningActive }, warning };
}
