import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORTFOLIO_GATE,
  directionCounts,
  evaluatePortfolioGate,
  openRiskPct,
  type OpenPos,
  type PortfolioState,
} from "../src/portfolio.js";

describe("openRiskPct", () => {
  it("sums downside risk as % of equity", () => {
    const pos: OpenPos[] = [
      { side: "long", entryPrice: 100, stop: 96, qty: 1 }, // risk 4
      { side: "short", entryPrice: 200, stop: 210, qty: 0.5 }, // risk 5
    ];
    // (4 + 5) / 900 * 100 = 1.0
    expect(openRiskPct(pos, 900)).toBeCloseTo(1.0);
  });

  it("locked-profit position (stop past entry) contributes zero", () => {
    const pos: OpenPos[] = [{ side: "long", entryPrice: 100, stop: 105, qty: 1 }];
    expect(openRiskPct(pos, 1000)).toBe(0);
  });
});

describe("directionCounts", () => {
  it("counts longs and shorts", () => {
    const pos: OpenPos[] = [
      { side: "long", entryPrice: 1, stop: 0, qty: 1 },
      { side: "long", entryPrice: 1, stop: 0, qty: 1 },
      { side: "short", entryPrice: 1, stop: 2, qty: 1 },
    ];
    expect(directionCounts(pos)).toEqual({ long: 2, short: 1 });
  });
});

describe("evaluatePortfolioGate", () => {
  const base: PortfolioState = {
    openRiskPct: 2,
    longCount: 1,
    shortCount: 0,
    realizedDailyPct: 0,
    realizedMonthlyPct: 0,
  };

  it("passes when all within limits", () => {
    const r = evaluatePortfolioGate("long", base);
    expect(r.demote).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  it("demotes when open risk at cap", () => {
    const r = evaluatePortfolioGate("long", { ...base, openRiskPct: 6 });
    expect(r.demote).toBe(true);
    expect(r.reasons[0]).toContain("오픈 리스크 캡");
  });

  it("demotes on daily loss throttle", () => {
    const r = evaluatePortfolioGate("long", { ...base, realizedDailyPct: -4.5 });
    expect(r.demote).toBe(true);
    expect(r.reasons[0]).toContain("일 손실");
  });

  it("demotes + halves risk on monthly loss throttle", () => {
    const r = evaluatePortfolioGate("long", { ...base, realizedMonthlyPct: -12 });
    expect(r.demote).toBe(true);
    expect(r.halveRisk).toBe(true);
  });

  it("warns (not demotes) on direction skew", () => {
    const r = evaluatePortfolioGate("long", { ...base, longCount: 3 });
    expect(r.demote).toBe(false);
    expect(r.warnings[0]).toContain("방향 편중");
  });

  it("respects custom config", () => {
    const r = evaluatePortfolioGate(
      "long",
      { ...base, openRiskPct: 3 },
      { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 3 },
    );
    expect(r.demote).toBe(true);
  });
});
