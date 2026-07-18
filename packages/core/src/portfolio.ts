import type { Side } from "./types.js";

/** Minimal open-position shape needed for portfolio risk math. */
export interface OpenPos {
  side: Side;
  entryPrice: number;
  stop: number;
  qty: number;
}

export interface PortfolioGateConfig {
  maxOpenRiskPct: number; // cap on summed open risk (default 6)
  maxSameDir: number; // warn when this many same-direction positions open (default 3)
  dailyLossPct: number; // daily realized-loss throttle (default 4)
  monthlyLossPct: number; // monthly realized-loss throttle (default 10)
}

export const DEFAULT_PORTFOLIO_GATE: PortfolioGateConfig = {
  maxOpenRiskPct: 6,
  maxSameDir: 3,
  dailyLossPct: 4,
  monthlyLossPct: 10,
};

export interface PortfolioState {
  openRiskPct: number;
  longCount: number;
  shortCount: number;
  realizedDailyPct: number; // signed; losses negative
  realizedMonthlyPct: number;
}

export interface GateResult {
  demote: boolean; // downgrade the new entry signal to informational
  halveRisk: boolean; // suggest 1% sizing (monthly throttle)
  reasons: string[]; // why demoted
  warnings: string[]; // non-blocking cautions (e.g. direction skew)
}

/**
 * Summed open downside risk as % of equity. A position whose stop is already
 * past entry (locked profit) contributes 0 — no remaining downside.
 */
export function openRiskPct(positions: OpenPos[], equity: number): number {
  if (equity <= 0) return 0;
  let risk = 0;
  for (const p of positions) {
    const perUnit = p.side === "long" ? p.entryPrice - p.stop : p.stop - p.entryPrice;
    if (perUnit > 0) risk += perUnit * p.qty;
  }
  return (risk / equity) * 100;
}

export function directionCounts(positions: OpenPos[]): { long: number; short: number } {
  let long = 0;
  let short = 0;
  for (const p of positions) p.side === "long" ? long++ : short++;
  return { long, short };
}

/**
 * Evaluate whether a prospective entry in `dir` should be demoted to
 * informational and/or carry warnings, given current portfolio state.
 * Alert-only philosophy: never blocks, only downgrades + annotates.
 */
export function evaluatePortfolioGate(
  dir: Side,
  state: PortfolioState,
  cfg: PortfolioGateConfig = DEFAULT_PORTFOLIO_GATE,
): GateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let halveRisk = false;

  if (state.openRiskPct >= cfg.maxOpenRiskPct) {
    reasons.push(
      `오픈 리스크 캡 도달 (${state.openRiskPct.toFixed(1)}%/${cfg.maxOpenRiskPct.toFixed(1)}%)`,
    );
  }
  if (state.realizedDailyPct <= -cfg.dailyLossPct) {
    reasons.push(`일 손실 스로틀 (${state.realizedDailyPct.toFixed(1)}% ≤ −${cfg.dailyLossPct}%)`);
  }
  if (state.realizedMonthlyPct <= -cfg.monthlyLossPct) {
    reasons.push(`월 손실 스로틀 (${state.realizedMonthlyPct.toFixed(1)}% ≤ −${cfg.monthlyLossPct}%)`);
    halveRisk = true;
  }

  const sameDir = dir === "long" ? state.longCount : state.shortCount;
  if (sameDir >= cfg.maxSameDir) {
    warnings.push(`방향 편중 — 동일 방향 포지션 ${sameDir}개`);
  }

  return { demote: reasons.length > 0, halveRisk, reasons, warnings };
}
