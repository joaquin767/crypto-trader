// Symbol recommender — finds the best USDT linear perpetual symbols
// for small capital trading based on lot size and price.

import type { BybitConfig } from "../bybit/types.ts";

export interface SymbolRecommendation {
  symbol: string;           // e.g. "SOL/USDT"
  bybitSymbol: string;      // e.g. "SOLUSDT"
  price: number;            // current price in USD
  minQty: number;           // minimum order quantity (contracts)
  minTradeCost: number;     // minQty * price = minimum USD needed per trade
  volume24h: number;        // 24h volume in USD (liquidity indicator)
  score: number;            // composite score (higher = better for small capital)
  reason: string;           // why this symbol was selected
}

type RecommenderRestClient = {
  getInstruments: (category: string, symbol?: string) => Promise<{ category: string; list: unknown[] }>;
  getTickers: (category: string, symbol?: string) => Promise<{ category: string; list: unknown[] }>;
  getOrderbook: (category: string, symbol: string, level?: number) => Promise<{ bids: [string, string][]; asks: [string, string][]; timestamp: number }>;
};

/**
 * 24h reported volume says nothing about liquidity *right now* — a symbol can
 * have real 24h turnover yet an empty book at this instant, especially on
 * testnet. This was observed live: GRT/USDT scored "Excellent for small
 * capital" on affordability alone and was auto-selected, then three separate
 * market buys were cancelled outright by Bybit (IOC, "EC_NoImmediateQtyToFill",
 * cumExecQty 0) because there was nothing on the ask side to match against.
 * Checks whether the ask side of the book actually has enough depth to fill a
 * market buy of `requiredUsd` without immediately cancelling for lack of
 * an immediate match.
 */
async function hasImmediateLiquidity(
  restClient: Pick<RecommenderRestClient, "getOrderbook">,
  bybitSymbol: string,
  requiredUsd: number,
): Promise<{ ok: boolean; reason: string }> {
  try {
    const book = await restClient.getOrderbook("linear", bybitSymbol, 25);
    if (!book.asks || book.asks.length === 0) {
      return { ok: false, reason: "empty ask side" };
    }
    let depthUsd = 0;
    for (const [priceStr, sizeStr] of book.asks) {
      depthUsd += Number.parseFloat(priceStr) * Number.parseFloat(sizeStr);
      if (depthUsd >= requiredUsd) return { ok: true, reason: "" };
    }
    return { ok: false, reason: `only ~$${depthUsd.toFixed(2)} of ask-side depth in the top 25 levels, need ~$${requiredUsd.toFixed(2)}` };
  } catch (err) {
    // Fail closed — an unverifiable symbol is excluded, not assumed fine.
    return { ok: false, reason: `orderbook check failed: ${(err as Error).message}` };
  }
}

/**
 * Fetch and recommend the best symbols for the user's capital.
 * Uses the Bybit REST client to get instruments info, current prices, and
 * (for the top-scoring candidates) actual order-book depth.
 */
export async function recommendSymbols(
  restClient: RecommenderRestClient,
  maxCapitalUsd: number,
  maxPositionSizeUsd: number,
  maxSymbols: number = 5,
): Promise<SymbolRecommendation[]> {
  try {
    // Fetch all linear instruments
    const instruments = await restClient.getInstruments("linear");
    const list = instruments.list as any[];

    if (!list || list.length === 0) {
      return [];
    }

    const recommendations: SymbolRecommendation[] = [];

    for (const inst of list) {
      // Only USDT perpetuals
      if (!inst.symbol || !inst.symbol.endsWith("USDT")) continue;
      if (inst.contractType !== "LinearPerpetual") continue;

      // Parse lot size filter
      const lotFilter = inst.lotSizeFilter;
      if (!lotFilter) continue;

      const minQty = Number.parseFloat(lotFilter.minOrderQty || "0");
      const qtyStep = Number.parseFloat(lotFilter.qtyStep || "0.001");
      if (minQty <= 0) continue;

      // Get current price from the price filter
      const priceFilter = inst.priceFilter;
      const tickSize = priceFilter ? Number.parseFloat(priceFilter.tickSize || "0.01") : 0.01;

      // We need the current price — we'll use markPrice from the instrument if available
      // or we'll use a placeholder that gets updated later
      const price = 0; // Will be filled by getTickers call

      // For scoring, we need the price. We'll do a second pass after fetching tickers.
      recommendations.push({
        symbol: inst.symbol.replace(/(USDT|USDC|USD)$/, "/$1"),
        bybitSymbol: inst.symbol,
        price: 0, // placeholder
        minQty,
        minTradeCost: 0, // placeholder
        volume24h: 0, // placeholder
        score: 0,
        reason: "",
      });
    }

    // Now fetch current prices for all symbols
    const tickers = await restClient.getTickers("linear");
    const tickerList = (tickers as any).list as any[] || [];
    const priceMap = new Map<string, { price: number; volume24h: number }>();

    for (const t of tickerList) {
      if (t.symbol) {
        priceMap.set(t.symbol, {
          price: Number.parseFloat(t.lastPrice || "0"),
          volume24h: Number.parseFloat(t.volume24h || "0") * Number.parseFloat(t.lastPrice || "0"),
        });
      }
    }

    // Score each symbol
    const scored: SymbolRecommendation[] = [];

    for (const rec of recommendations) {
      const priceData = priceMap.get(rec.bybitSymbol);
      if (!priceData || priceData.price <= 0) continue;

      const price = priceData.price;
      const minTradeCost = rec.minQty * price;
      const volume24h = priceData.volume24h;

      // Score: higher is better for small capital
      // 1. Affordability: how many min trades fit in our capital
      const affordability = maxCapitalUsd / minTradeCost;

      // 2. Liquidity factor
      const liquidityFactor = Math.min(volume24h / 1000000, 100); // cap at 100M

      // 3. Position fit: how many positions of maxPositionSizeUsd fit in capital
      const positionFit = maxCapitalUsd / Math.max(maxPositionSizeUsd, minTradeCost);

      // Composite score: affordability matters most for small capital
      const score = affordability * 10 + liquidityFactor * 0.1 + positionFit * 5;

      // Only include symbols we can actually afford
      if (minTradeCost <= maxCapitalUsd * 0.8) {
        let reason = "";
        if (affordability >= 10) reason = "Excellent for small capital";
        else if (affordability >= 5) reason = "Good for small capital";
        else if (affordability >= 2) reason = "Affordable";
        else reason = "Fits in capital";

        scored.push({
          ...rec,
          price,
          minTradeCost,
          volume24h,
          score,
          reason,
        });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Filter down to symbols with real, immediate order-book depth — the
    // score above is otherwise blind to "is there actually anyone to trade
    // against right now" (see hasImmediateLiquidity's doc comment). Checked
    // in score order, capped at a bounded number of candidates so a long tail
    // of illiquid symbols can't turn this into dozens of orderbook calls.
    const requiredDepthUsd = Math.max(maxPositionSizeUsd, 10);
    const MAX_CANDIDATES_CHECKED = 20;
    const withLiquidity: SymbolRecommendation[] = [];
    for (const rec of scored.slice(0, MAX_CANDIDATES_CHECKED)) {
      if (withLiquidity.length >= maxSymbols) break;
      const liquidity = await hasImmediateLiquidity(restClient, rec.bybitSymbol, requiredDepthUsd);
      if (liquidity.ok) {
        withLiquidity.push(rec);
      } else {
        console.warn(`[symbols] Skipping ${rec.symbol} (score ${rec.score.toFixed(1)}) — insufficient order-book liquidity: ${liquidity.reason}`);
      }
    }

    return withLiquidity;
  } catch (err) {
    console.warn(`[symbols] Failed to recommend symbols: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Check if the currently configured symbols are affordable.
 * Returns a list of unaffordable symbols with their minimum trade cost.
 */
export async function checkConfiguredSymbols(
  restClient: { getTickers: (category: string, symbol?: string) => Promise<{ category: string; list: unknown[] }> },
  symbols: string[],
  maxCapitalUsd: number,
): Promise<{ symbol: string; minTradeCost: number; affordable: boolean }[]> {
  const results: { symbol: string; minTradeCost: number; affordable: boolean }[] = [];

  try {
    for (const symbol of symbols) {
      const bybitSymbol = symbol.replace("/", "");
      const tickers = await restClient.getTickers("linear", bybitSymbol);
      const list = (tickers as any).list as any[] || [];
      if (list.length === 0) {
        results.push({ symbol, minTradeCost: 0, affordable: false });
        continue;
      }

      const price = Number.parseFloat(list[0].lastPrice || "0");
      // We need minQty — we can get it from the ticker's lot size info
      // But tickers don't include lotSizeFilter. We'll use a reasonable default.
      // For most USDT perpetuals, the minimum is around 0.001-1 unit.
      // We'll estimate based on price: cheaper assets have higher minQty.
      const estimatedMinQty = price > 1000 ? 0.001 : price > 100 ? 0.01 : price > 10 ? 0.1 : 1;
      const minTradeCost = estimatedMinQty * price;

      results.push({
        symbol,
        minTradeCost,
        affordable: minTradeCost <= maxCapitalUsd * 0.8,
      });
    }
  } catch (err) {
    console.warn(`[symbols] Failed to check symbols: ${(err as Error).message}`);
  }

  return results;
}