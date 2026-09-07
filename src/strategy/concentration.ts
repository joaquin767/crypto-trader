// Concentration limits — see specs/live-trading-readiness.md §10.
//
// autoSelectSymbols picks the top-N symbols purely by affordability/liquidity
// score, with no check on whether they're actually diversified — several
// low-cap alts that move together in a broad selloff give the illusion of
// spread-out risk while behaving like one concentrated bet. Pure functions
// throughout, same style as circuit-breaker.ts — trivially testable without
// mocking the rest of the app.

export interface ConcentrationCheck {
  skip: boolean;
  reason?: string;
}

/** Caps how many positions may be open at once. `false`/undefined = uncapped. */
export function checkConcurrentPositionsLimit(
  openCount: number,
  maxConcurrentPositions: number | false | undefined,
): ConcentrationCheck {
  if (maxConcurrentPositions === false || maxConcurrentPositions === undefined) return { skip: false };
  if (openCount >= maxConcurrentPositions) {
    return {
      skip: true,
      reason: `${openCount} open position(s) already at the configured limit (${maxConcurrentPositions})`,
    };
  }
  return { skip: false };
}

/** Period-over-period % returns from a price series. */
export function calcReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    if (prev !== 0) returns.push((prices[i]! - prev) / prev);
  }
  return returns;
}

/**
 * Pearson correlation coefficient between two return series, aligned by
 * taking the trailing N points each has in common (N = min length) — an
 * approximation, not a true same-timestamp alignment (ticks for different
 * symbols don't arrive in lockstep), but cheap and good enough to catch
 * "these two obviously move together," which is the actual goal here.
 * Returns 0 if either series is too short or has zero variance.
 */
export function calcCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const aSlice = a.slice(-n);
  const bSlice = b.slice(-n);
  const meanA = aSlice.reduce((s, x) => s + x, 0) / n;
  const meanB = bSlice.reduce((s, x) => s + x, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = aSlice[i]! - meanA;
    const db = bSlice[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Skip opening a new position whose trailing return correlation with any
 * already-open position exceeds the threshold. `maxCorrelation` false/undefined
 * disables the check entirely.
 */
export function checkCorrelationLimit(
  candidateSymbol: string,
  candidatePrices: number[],
  openPositions: { symbol: string; prices: number[] }[],
  maxCorrelation: number | false | undefined,
): ConcentrationCheck {
  if (maxCorrelation === false || maxCorrelation === undefined) return { skip: false };
  const candidateReturns = calcReturns(candidatePrices);
  for (const pos of openPositions) {
    if (pos.symbol === candidateSymbol) continue;
    const corr = calcCorrelation(candidateReturns, calcReturns(pos.prices));
    if (Math.abs(corr) >= maxCorrelation) {
      return {
        skip: true,
        reason: `trailing correlation ${corr.toFixed(2)} with open position ${pos.symbol} meets/exceeds the limit (${maxCorrelation})`,
      };
    }
  }
  return { skip: false };
}
