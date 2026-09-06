// Strategy optimizer — adjusts parameters based on recent performance.
// This is the "learning from mistakes" engine.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface StrategyParams {
  rsiOversoldThreshold: number;
  rsiOverboughtThreshold: number;
  minBuyScore: number;
  momentumMin: number;
  momentumMax: number;
  volatilityCap: number;
}

export interface LearningInsight {
  param: keyof StrategyParams;
  oldValue: number;
  newValue: number;
  reason: string;
  round: number;
}

const INSIGHTS_FILE = "learning-insights.json";
const _insights: LearningInsight[] = [];
let _round = 0;

// Load persisted insights on module init
try {
  const insightsPath = join(process.cwd(), INSIGHTS_FILE);
  if (existsSync(insightsPath)) {
    const raw = JSON.parse(readFileSync(insightsPath, "utf-8"));
    if (Array.isArray(raw.insights)) _insights.push(...raw.insights);
    if (typeof raw.round === "number") _round = raw.round;
    console.log(`[learning] Loaded ${_insights.length} insights from disk (round ${_round})`);
  }
} catch {
  // First run — no file yet
}

/** Persist insights to disk. */
function persistInsights(): void {
  try {
    writeFileSync(
      join(process.cwd(), INSIGHTS_FILE),
      JSON.stringify({ insights: _insights, round: _round }, null, 2),
    );
  } catch (err) {
    console.warn(`[learning] Failed to persist insights: ${(err as Error).message}`);
  }
}

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

/**
 * Optimize strategy parameters based on recent performance.
 *
 * Learning rules (trigger after just 3 closed trades):
 * - If win rate < 40% → become more conservative (raise minBuyScore)
 * - If win rate > 65% but limited data → cautiously expand (lower rsiOversoldThreshold)
 * - If avgLoss > 1.5 * avgWin → tighten risk (lower volatilityCap)
 * - If maxDrawdown > 15% → exit sooner (raise rsiOverboughtThreshold)
 *
 * Only one parameter is adjusted per optimization round.
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

  // Rule 1: Low win rate → be more selective (min 3 trades)
  if (totalTrades >= 3 && winRate < 0.4) {
    if (adjusted.minBuyScore < 6) {
      adjusted.minBuyScore = Math.min(6, adjusted.minBuyScore + 1);
      insights.push(`win rate ${(winRate * 100).toFixed(0)}% < 40% → minBuyScore ${adjusted.minBuyScore}`);
    }
  }

  // Rule 2: Good results but limited data → cautious aggression (min 3 trades)
  if (totalTrades >= 3 && totalTrades < 20 && winRate > 0.65) {
    if (adjusted.rsiOversoldThreshold < 35) {
      adjusted.rsiOversoldThreshold += 2;
      insights.push(`good win rate (${(winRate * 100).toFixed(0)}%) → more opportunities, RSI threshold ${adjusted.rsiOversoldThreshold}`);
    }
  }

  // Rule 3: Losses too big relative to wins (min 3 trades)
  if (totalTrades >= 3 && avgLoss !== 0 && avgWin !== 0 && Math.abs(avgLoss) > Math.abs(avgWin) * 1.5) {
    if (adjusted.volatilityCap > 3) {
      adjusted.volatilityCap = Math.max(3, adjusted.volatilityCap - 0.5);
      insights.push(`avg loss > avg win → lower volatility cap to ${adjusted.volatilityCap}%`);
    }
  }

  // Rule 4: High drawdown → tighter risk (min 3 trades)
  if (totalTrades >= 3 && maxDrawdown > 15) {
    if (adjusted.rsiOverboughtThreshold < 75) {
      adjusted.rsiOverboughtThreshold += 2;
      insights.push(`drawdown ${maxDrawdown.toFixed(0)}% > 15% → exit sooner, RSI overbought ${adjusted.rsiOverboughtThreshold}`);
    }
  }

  // Record and persist insights
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
    persistInsights();
  }

  return adjusted;
}