// Manual journal types — specs/daily-catalyst-manual-trading.md §5.7.
//
// Phase 2 stub: types only, no behavior. loadManualJournal/saveManualJournal/linkTradeToPlan/
// recordPaperEntry/recordPaperExit are implemented in Phase 3 (§9). These types exist now only
// so src/research/report.ts's `DailyReport.openTrades`/`openTradeThesis` inputs and the
// `research:daily` script (which passes `openTrades: ManualTrade[] = []` until Phase 3)
// compile against the final shape ahead of time.

import type { AiStance } from "../research/ai/types.ts";
import type { TradePlan } from "../research/planner.ts";

export type ManualTradeVenue = "paper" | "bybit-live"; // testnet deliberately excluded
export type ExitKind = "stop" | "target" | "time" | "thesis_invalidated" | "discretionary" | "liquidation" | "unknown";

export interface Fill {
  execId: string;
  time: number;
  price: number;
  qty: number;
  feeUsd: number;
  side: "buy" | "sell";
}

export interface ManualTrade {
  id: string; // uuid
  venue: ManualTradeVenue;
  symbol: string;
  side: "long" | "short";
  planId: string | null; // null => unplanned
  ruleId: string | null;
  ruleHash: string | null;
  plannedSnapshot: Extract<TradePlan, { kind: "plan" }> | null; // frozen copy at link time
  aiStanceAtPlan: AiStance | null; // AI assessment of this plan in the same report; null if unplanned, AI unavailable, or plan is AI-origin
  entryFills: Fill[];
  exitFills: Fill[];
  actualLeverage: number | null;
  exchangeLiqPrice: number | null;
  fundingUsd: number; // signed; negative = paid
  status: "open" | "closed";
  exitKind: ExitKind | null;
  notes: string; // owner free text, pre- and post-trade
  createdAt: number;
  updatedAt: number;
}
