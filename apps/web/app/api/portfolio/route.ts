import { NextResponse } from "next/server";
import {
  DEFAULT_PORTFOLIO_GATE,
  directionCounts,
  evaluatePortfolioGate,
  openRiskPct,
  type OpenPos,
  type PortfolioGateConfig,
} from "@turtle/core";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function startOfUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const repo = getRepo();

  const equity = Number(repo.getSetting("equity") ?? 0);
  const riskPct = Number(repo.getSetting("riskPct") ?? 2);
  const cfg: PortfolioGateConfig = (() => {
    const raw = repo.getSetting("portfolioGate");
    if (!raw) return DEFAULT_PORTFOLIO_GATE;
    try {
      return { ...DEFAULT_PORTFOLIO_GATE, ...JSON.parse(raw) };
    } catch {
      return DEFAULT_PORTFOLIO_GATE;
    }
  })();

  const openPos: OpenPos[] = repo.listOpenPositions().map((p) => ({
    side: p.side,
    entryPrice: p.entryPrice,
    stop: p.stop,
    qty: p.qty,
  }));
  const counts = directionCounts(openPos);
  const risk = equity > 0 ? openRiskPct(openPos, equity) : 0;

  const now = Date.now();
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);
  let daily = 0;
  let monthly = 0;
  for (const p of repo.listPositions(1000)) {
    if (p.status !== "closed" || p.closedAt == null || p.realizedR == null) continue;
    const pnl = p.realizedR * riskPct;
    if (p.closedAt >= monthStart) monthly += pnl;
    if (p.closedAt >= dayStart) daily += pnl;
  }

  const state = {
    openRiskPct: risk,
    longCount: counts.long,
    shortCount: counts.short,
    realizedDailyPct: daily,
    realizedMonthlyPct: monthly,
  };
  // gate preview for each direction (for display badges)
  const longGate = evaluatePortfolioGate("long", state, cfg);
  const shortGate = evaluatePortfolioGate("short", state, cfg);

  return NextResponse.json({ state, cfg, longGate, shortGate });
}
