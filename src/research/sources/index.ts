// Aggregates every source adapter.

import type { AdapterDeps } from "../http.ts";
import type { SourceAdapter } from "../types.ts";
import { createBybitFundingAdapter } from "./bybit-funding.ts";
import { createBybitInstrumentsAdapter } from "./bybit-instruments.ts";
import { createBybitKlines1dAdapter, createBybitKlines1hAdapter } from "./bybit-klines.ts";
import { createBybitOiAdapter } from "./bybit-oi.ts";
import { createCoinalyzeOiAdapter } from "./coinalyze-oi.ts";
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
    createCoinalyzeOiAdapter(deps),
    createBybitInstrumentsAdapter(deps),
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
  createBybitFundingAdapter,
  createBybitInstrumentsAdapter,
  createBybitKlines1dAdapter,
  createBybitKlines1hAdapter,
  createBybitOiAdapter,
  createCoinalyzeOiAdapter,
  createDefillamaStablecoinsAdapter,
  createFarsideBtcAdapter,
  createFarsideEthAdapter,
  createFearGreedAdapter,
  createFredReleaseDatesAdapter,
  createMacroCalendarManualAdapter,
  createUnlocksManualAdapter,
};
