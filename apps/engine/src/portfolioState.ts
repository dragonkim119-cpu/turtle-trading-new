import {
  directionCounts,
  openRiskPct,
  type OpenPos,
  type PortfolioState,
} from "@turtle/core";
import type { Repo } from "@turtle/db";

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function startOfUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Compute portfolio risk state from the DB on demand (no separate state table —
 * avoids reset-logic bugs). Realized daily/monthly P&L is approximated as
 * realizedR × riskPct% per closed position (throttle uses realized only;
 * unrealized throttle is a later refinement).
 */
export function computePortfolioState(
  repo: Repo,
  equity: number,
  riskPct: number,
  nowMs: number,
): PortfolioState {
  const openPos: OpenPos[] = repo.listOpenPositions().map((p) => ({
    side: p.side,
    entryPrice: p.entryPrice,
    stop: p.stop,
    qty: p.qty,
  }));
  const counts = directionCounts(openPos);

  const dayStart = startOfUtcDay(nowMs);
  const monthStart = startOfUtcMonth(nowMs);
  let daily = 0;
  let monthly = 0;
  for (const p of repo.listPositions(1000)) {
    if (p.status !== "closed" || p.closedAt == null || p.realizedR == null) continue;
    const pnlPct = p.realizedR * riskPct; // riskPct% of equity per 1R
    if (p.closedAt >= monthStart) monthly += pnlPct;
    if (p.closedAt >= dayStart) daily += pnlPct;
  }

  return {
    openRiskPct: openRiskPct(openPos, equity),
    longCount: counts.long,
    shortCount: counts.short,
    realizedDailyPct: daily,
    realizedMonthlyPct: monthly,
  };
}
