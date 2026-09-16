// Aggregates every Phase 1 source adapter. `coinalyze-oi` is a valid SourceId (§5.1) but has
// no adapter until Phase 6 (§9) — it is intentionally absent here.

import type { AdapterDeps } from "../http.ts";
import type { SourceAdapter } from "../types.ts";
import { createBybitFundingAdapter } from "./bybit-funding.ts";
import { createBybitKlines1dAdapter, createBybitKlines1hAdapter } from "./bybit-klines.ts";
import { createBybitOiAdapter } from "./bybit-oi.ts";
import { createDefillamaStablecoinsAdapter } from "./defillama-stablecoins.ts";
import { createFarsideBtcAdapter, createFarsideEthAdapter } from "./farside.ts";
import { createFearGreedAdapter } from "./fear-greed.ts";
import { createFredReleaseDatesAdapter } from "./fred-release-dates.ts";
import { createMacroCalendarManualAdapter } from "./macro-calendar-manual.ts";
import { createUnlocksManualAdapter } from "./unlocks-manual.ts";

export function createAllSourceAdapters(deps: AdapterDeps): SourceAdapter[] {
  return [
    createBybitKlines1dAdapter(deps),
    createBybitKlines1hAdapter(deps),
    createBybitFundingAdapter(deps),
    createBybitOiAdapter(deps),
    createFarsideBtcAdapter(deps),
    createFarsideEthAdapter(deps),
    createFredReleaseDatesAdapter(deps),
    createMacroCalendarManualAdapter(deps),
    createDefillamaStablecoinsAdapter(deps),
    createFearGreedAdapter(deps),
    createUnlocksManualAdapter(deps),
  ];
}

export {
  createBybitKlines1dAdapter,
  createBybitKlines1hAdapter,
  createBybitFundingAdapter,
  createBybitOiAdapter,
  createFarsideBtcAdapter,
  createFarsideEthAdapter,
  createFredReleaseDatesAdapter,
  createMacroCalendarManualAdapter,
  createDefillamaStablecoinsAdapter,
  createFearGreedAdapter,
  createUnlocksManualAdapter,
};
