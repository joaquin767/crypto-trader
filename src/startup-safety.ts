// Startup capital sanity check — see specs/live-trading-readiness.md §7.2.
//
// docs/BYBIT_INTEGRATION.md has always suggested "start with maxCapitalUsd: 50
// — only increase after 50+ profitable trades," but that was documentation-only
// advice with nothing in the code enforcing or even nudging toward it. This
// encodes it as an actual gate for --live runs above a threshold: interactive
// sessions must type an exact confirmation phrase; non-interactive ones (a
// background service — exactly where an unattended, larger-capital live run is
// least supervised) refuse to start rather than silently proceeding, since
// there's no way to obtain confirmation from nobody watching.

import type { Config } from "./config.ts";

export class StartupSafetyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StartupSafetyError";
  }
}

const DEFAULT_WARN_THRESHOLD = 500;
export const CONFIRMATION_PHRASE = "I UNDERSTAND THE RISK";

/**
 * Returns the effective warn threshold if a --live run's maxCapitalUsd should
 * trigger the confirmation gate, or null if no gate applies (paper/testnet
 * mode, the check is explicitly disabled via `false`, or capital is at or
 * below the threshold).
 */
export function capitalThresholdToWarn(config: Config, mode: "paper" | "live" | "testnet"): number | null {
  if (mode !== "live") return null;
  if (config.maxCapitalUsdWarnThreshold === false) return null;
  const threshold = config.maxCapitalUsdWarnThreshold ?? DEFAULT_WARN_THRESHOLD;
  if (config.maxCapitalUsd <= threshold) return null;
  return threshold;
}

/**
 * Enforce the gate: prompt for confirmation (`promptFn`, injectable for
 * testing — defaults to reading a line from real stdin) if interactive,
 * otherwise throw immediately. Throws StartupSafetyError if the gate applies
 * and isn't satisfied; resolves silently otherwise (including when no gate
 * applies at all).
 */
export async function assertCapitalThresholdOk(
  config: Config,
  mode: "paper" | "live" | "testnet",
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  isInteractive: boolean = Boolean(process.stdin.isTTY),
  promptFn: (question: string) => Promise<string> = defaultPrompt,
): Promise<void> {
  const threshold = capitalThresholdToWarn(config, mode);
  if (threshold === null) return;

  logger.warn(
    `⚠️  maxCapitalUsd ($${config.maxCapitalUsd}) exceeds the safety threshold ($${threshold}) for a --live run. ` +
    `docs/RISK_MANAGEMENT.md recommends starting small and increasing only after a track record of profitable trades.`,
  );

  if (!isInteractive) {
    throw new StartupSafetyError(
      `Refusing to start non-interactively with maxCapitalUsd ($${config.maxCapitalUsd}) above the ` +
      `$${threshold} safety threshold — there's no one to confirm this. Either lower maxCapitalUsd, ` +
      `explicitly raise or disable maxCapitalUsdWarnThreshold in config.json (an explicit, conscious ` +
      `override), or run interactively to confirm.`,
    );
  }

  const answer = await promptFn(`Type "${CONFIRMATION_PHRASE}" to continue, or anything else to abort: `);
  if (answer.trim() !== CONFIRMATION_PHRASE) {
    throw new StartupSafetyError("Confirmation phrase did not match — refusing to start.");
  }
}

async function defaultPrompt(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
