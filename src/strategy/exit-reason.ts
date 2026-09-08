// Why a position closed.
//
// Lives in its own module rather than in learning/journal.ts because the
// executor needs to classify an exit in order to fee it correctly, and
// journal.ts already imports TradeResult from the executor — importing back
// the other way would close a cycle.

/**
 * Recorded at close so a losing streak can be attributed. Before this existed
 * a closed trade kept only its ENTRY reason, so "stops are too tight", "the
 * horizon is too short" and "the model gate stopped working" were
 * indistinguishable after the fact.
 * See specs/profit-target-roadmap.md F2 / G1.1.
 */
export type ExitReason =
  | "take_profit" | "stop_loss" | "horizon"
  | "manual" | "circuit_breaker" | "reconciled";

/** Aggregate bucket for records written before exit attribution existed.
 *  Deliberately NOT a member of ExitReason: no NEW trade may be written as
 *  "unknown" — an unattributable close is "reconciled", and logs a warning. */
export type ExitReasonBucket = ExitReason | "unknown";

/**
 * Classify a close from the sell signal's reason text.
 *
 * The reason strings are generated in a small number of known places in
 * signals.ts and backtest.ts (`stop-loss: …`, `take-profit: …`,
 * `model horizon elapsed …`), so matching their stable prefixes is reliable.
 * Anything unrecognised falls through to "reconciled" rather than being
 * guessed into a bucket — an unattributed close must never be silently
 * counted as a take-profit, least of all now that the take-profit bucket is
 * what earns the maker fee (see executor.ts).
 */
export function classifyExitReason(reason: string): ExitReason {
  if (reason.startsWith("stop-loss:")) return "stop_loss";
  if (reason.startsWith("take-profit:")) return "take_profit";
  if (reason.startsWith("model horizon elapsed")) return "horizon";
  if (reason.startsWith("circuit breaker")) return "circuit_breaker";
  return "reconciled";
}
