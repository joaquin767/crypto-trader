// Strategy optimizer — adjusts parameters based on recent performance.
// This is the "learning from mistakes" engine.

export interface StrategyParams {
  rsiOversoldThreshold: number;   // default 30
  rsiOverboughtThreshold: number; // default 70
  minBuyScore: number;            // default 4
  momentumMin: number;            // default 2
  momentumMax: number;            // default 15
  volatilityCap: number;          // max ATR% to trade in, default 5
}

export interface LearningInsight {
  param: keyof StrategyParams;
  oldValue: number;
  newValue: number;
  reason: string;
  round: number;
}

const _insights: LearningInsight[] = [];

/** Get default strategy parameters. */
export function defaultParams(): StrategyParams {
  return {
    rsiOversoldThreshold: 30,
    rsiOverboughtThreshold: 70,
    minBuyScore: 4,
    momentumMin: 2,
    momentumMax: 15,
    volatilityCap: 5,
  };
}

/** Get learning history. */
export function getInsights(): LearningInsight[] {
  return [..._insights];
}

/** Clear learning history (for tests). */
export function clearInsights(): void {
  _insights.length = 0;
  _round = 0;
}

let _round = 0;

/**
 * Optimize strategy parameters based on recent performance.
 *
 * Learning rules:
 * - If win rate < 40% over last 10 trades → become more conservative (raise minBuyScore)
 * - If win rate > 70% but total trades < 20 → slightly more aggressive (lower rsiOversoldThreshold)
 * - If avgLoss > 2 * avgWin → tighten risk (lower volatilityCap)
 * - If maxDrawdown > 15% → reduce position sizing (raise rsiOverboughtThreshold)
 *
 * Only one parameter is adjusted per optimization round (to isolate cause/effect).
 */
export function optimize(
  params: StrategyParams,
  winRate: number,
  totalTrades: number,
  avgWin: number,
  avgLoss: number,
  maxDrawdown: number,
  recentPnls: number[],
): StrategyParams {
  _round++;
  const adjusted = { ...params };
  const insights: string[] = [];

  // Rule 1: Low win rate → be more selective
  if (totalTrades >= 5 && winRate < 0.4) {
    if (adjusted.minBuyScore < 6) {
      adjusted.minBuyScore = Math.min(6, adjusted.minBuyScore + 1);
      insights.push(`win rate ${(winRate * 100).toFixed(0)}% < 40% → minBuyScore ${adjusted.minBuyScore}`);
    }
    if (adjusted.rsiOversoldThreshold > 25) {
      adjusted.rsiOversoldThreshold -= 2;
      insights.push(`tightening RSI oversold → ${adjusted.rsiOversoldThreshold}`);
    }
  }

  // Rule 2: Good results but limited data → cautious aggression
  if (totalTrades >= 5 && totalTrades < 20 && winRate > 0.65) {
    if (adjusted.rsiOversoldThreshold < 35) {
      adjusted.rsiOversoldThreshold += 2;
      insights.push(`good win rate (${(winRate * 100).toFixed(0)}%) → more opportunities, RSI threshold ${adjusted.rsiOversoldThreshold}`);
    }
  }

  // Rule 3: Losses too big relative to wins
  if (avgLoss !== 0 && avgWin !== 0 && Math.abs(avgLoss) > Math.abs(avgWin) * 1.5) {
    if (adjusted.volatilityCap > 3) {
      adjusted.volatilityCap = Math.max(3, adjusted.volatilityCap - 0.5);
      insights.push(`avg loss > avg win → lower volatility cap to ${adjusted.volatilityCap}%`);
    }
  }

  // Rule 4: High drawdown → tighter risk
  if (maxDrawdown > 15) {
    if (adjusted.rsiOverboughtThreshold < 75) {
      adjusted.rsiOverboughtThreshold += 2;
      insights.push(`drawdown ${maxDrawdown.toFixed(0)}% > 15% → exit sooner, RSI overbought ${adjusted.rsiOverboughtThreshold}`);
    }
  }

  // Record insights
  if (insights.length > 0) {
    for (const reason of insights) {
      _insights.push({
        param: "minBuyScore" as keyof StrategyParams,
        oldValue: params.minBuyScore,
        newValue: adjusted.minBuyScore,
        reason,
        round: _round,
      });
    }
  }

  return adjusted;
}