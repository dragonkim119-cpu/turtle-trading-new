import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest.js";
import { runPortfolioBacktest, type SymbolInput } from "../src/portfolio-backtest.js";
import { DEFAULT_PORTFOLIO_GATE } from "../src/portfolio.js";
import type { Candle, Params } from "../src/types.js";

function c(high: number, low: number, close: number, volume = 100, openTime = 0): Candle {
  return { openTime, open: close, high, low, close, volume };
}

const P: Params = {
  entryPeriod: 3,
  exitPeriod: 2,
  atrPeriod: 2,
  stopMult: 2,
  emaPeriod: 3,
  riskPct: 2,
  entryBufferAtr: 0,
  partialTp: null,
  timeStop: null,
  filters: {
    adx: { on: false, period: 14, min: 20 },
    volume: { on: false, period: 20, mult: 1.5 },
    vwap: { on: false, bars: 30 },
    funding: { on: false, maxAbs: 0.001 },
    oi: { on: false, minChangePct: 0 },
    regime: { on: false, emaPeriod: 200 },
  },
};

// exitPeriod:100 disables the channel exit entirely (needs >=100 bars of
// history) -- used only for the short explicit-stop-hit fixture below, where
// the channel must NOT fire so the stop is the only way the trade closes.
// trendCandles-based tests need the real exitPeriod:2 channel exit (P above)
// to ever close the position the reversal opens, or the trade never appears
// in `trades` at all.
const P_NO_CHANNEL: Params = { ...P, exitPeriod: 100 };

function trendCandles(startOpenTime: number): Candle[] {
  const candles: Candle[] = [];
  let t = startOpenTime;
  for (let i = 0; i < 6; i++) candles.push(c(10, 9, 9.5, 100, t++));
  for (let i = 0; i < 15; i++) candles.push(c(11 + i, 10 + i, 10.8 + i, 100, t++));
  for (let i = 0; i < 8; i++) candles.push(c(25 - 2 * i, 23 - 2 * i, 23.5 - 2 * i, 100, t++));
  return candles;
}

describe("runPortfolioBacktest — single symbol reduces to runBacktest", () => {
  it("matches runBacktest trades and endEquity when gate is disabled", () => {
    const candles = trendCandles(0);
    const solo = runBacktest(candles, P, 1000);
    const portfolio = runPortfolioBacktest(
      [{ symbol: "X", candles, params: P }],
      undefined,
      1000,
      undefined,
      false,
    );
    expect(portfolio.trades.length).toBe(solo.trades.length);
    for (let i = 0; i < solo.trades.length; i++) {
      expect(portfolio.trades[i].rMultiple).toBeCloseTo(solo.trades[i].rMultiple, 6);
      expect(portfolio.trades[i].exitReason).toBe(solo.trades[i].exitReason);
    }
    expect(portfolio.stats.endEquity).toBeCloseTo(solo.stats.endEquity, 6);
  });

  it("a stop-close bar does not double as a fresh entry bar (matches runBacktest)", () => {
    // base3 flat -> breakout long @12 -> next bar stop-hits AND would satisfy a fresh
    // short breakout on the same bar if re-evaluated. runBacktest's single-loop
    // `continue` never re-checks entries on a bar that just closed a position —
    // the portfolio engine's two-pass (exits then entries) design must replicate
    // that via a same-timestamp "just closed" guard.
    const candles = [
      c(9.5, 8.5, 9, 100, 0),
      c(9.5, 8.5, 9, 100, 1),
      c(9.5, 8.5, 9, 100, 2),
      c(12, 9, 12, 100, 3), // breakout entry @12, ATR=2, stop=8
      c(8, 5, 6, 100, 4), // low 5 <= stop 8 -> stop hit; close 6 would also break short
    ];
    const solo = runBacktest(candles, P_NO_CHANNEL, 1000);
    const portfolio = runPortfolioBacktest(
      [{ symbol: "X", candles, params: P_NO_CHANNEL }],
      undefined,
      1000,
      undefined,
      false,
    );
    expect(solo.trades).toHaveLength(1);
    expect(portfolio.trades).toHaveLength(1);
    expect(portfolio.trades[0].rMultiple).toBeCloseTo(solo.trades[0].rMultiple, 6);
  });
});

describe("runPortfolioBacktest — shared equity compounds sequentially", () => {
  it("combined endEquity is the product of each trade's pnlPct, not their sum", () => {
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: trendCandles(0), params: P },
      { symbol: "B", candles: trendCandles(100), params: P },
    ];
    const result = runPortfolioBacktest(inputs, undefined, 1000, undefined, false);
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0].symbol).toBe("A");
    expect(result.trades[1].symbol).toBe("B");
    expect(result.trades[0].pnlPct).toBeGreaterThan(0);
    expect(result.trades[1].pnlPct).toBeGreaterThan(0);
    const expected = 1000 * (1 + result.trades[0].pnlPct) * (1 + result.trades[1].pnlPct);
    expect(result.stats.endEquity).toBeCloseTo(expected, 6);
    // proves compounding, not naive addition on the original base
    const naiveSum = 1000 * (1 + result.trades[0].pnlPct + result.trades[1].pnlPct);
    expect(result.stats.endEquity).not.toBeCloseTo(naiveSum, 2);
  });
});

describe("runPortfolioBacktest — portfolio gate: open risk cap", () => {
  it("demotes (skips) a second symbol's entry while risk cap is already exceeded", () => {
    // A opens and closes -> contributes exactly riskPct% (2%) of open risk at entry time.
    // B tries to enter while A's risk is open but gets demoted by maxOpenRiskPct gate.
    const candlesA = [
      c(9.5, 8.5, 9, 100, 0),
      c(9.5, 8.5, 9, 100, 1),
      c(9.5, 8.5, 9, 100, 2),
      c(12, 9, 12, 100, 3), // breakout entry @12, ATR=2, stop=8
      c(8, 5, 6, 100, 4), // stop hit -> trade closes
    ];
    const candlesB = [
      c(9.5, 8.5, 9, 100, 0),
      c(9.5, 8.5, 9, 100, 1),
      c(9.5, 8.5, 9, 100, 2),
      c(12, 9, 12, 100, 3), // breakout entry @12 (same time as A's entry, but processed after)
      c(10, 5, 9, 100, 4), // stop hits B's ungated position; not a fresh breakout signal (close 9 is inside B's own 8.5-12 band) so B never re-attempts entry in the gated case
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: candlesA, params: P_NO_CHANNEL },
      { symbol: "B", candles: candlesB, params: P_NO_CHANNEL },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 1 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "A")).toHaveLength(1);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(0);
    expect(gated.gateStats.demotedCount).toBe(1);

    const ungated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, false);
    expect(ungated.trades.filter((t) => t.symbol === "B")).toHaveLength(1);
    expect(ungated.gateStats.demotedCount).toBe(0);
  });
});

describe("runPortfolioBacktest — portfolio gate: daily loss throttle", () => {
  const H = 3_600_000;
  const BASE = Date.UTC(2024, 0, 1, 0, 0, 0);

  function lossFixture(): Candle[] {
    return [
      c(9.5, 8.5, 9, 100, BASE + 0 * H),
      c(9.5, 8.5, 9, 100, BASE + 1 * H),
      c(9.5, 8.5, 9, 100, BASE + 2 * H),
      c(12, 9, 12, 100, BASE + 3 * H), // breakout entry @12, ATR=2, stop=8
      c(8, 5, 6, 100, BASE + 4 * H), // stop hit -> ~-2% realized same day
    ];
  }

  it("demotes a same-day entry once the daily loss throttle is breached", () => {
    const candlesB = [
      c(9.5, 8.5, 9, 100, BASE + 1 * H),
      c(9.5, 8.5, 9, 100, BASE + 2 * H),
      c(9.5, 8.5, 9, 100, BASE + 3 * H),
      c(12, 9, 12, 100, BASE + 4 * H), // same bar A's loss closes on
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P_NO_CHANNEL },
      { symbol: "B", candles: candlesB, params: P_NO_CHANNEL },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 1, monthlyLossPct: 100 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(0);
    expect(gated.gateStats.demotedCount).toBe(1);
  });

  it("resets the daily bucket on the next UTC day", () => {
    const candlesB = [
      c(9.5, 8.5, 9, 100, BASE + 27 * H),
      c(9.5, 8.5, 9, 100, BASE + 28 * H),
      c(9.5, 8.5, 9, 100, BASE + 29 * H),
      c(12, 9, 12, 100, BASE + 30 * H), // next day (30h > 24h), breakout entry
      c(8, 5, 6, 100, BASE + 31 * H), // stop hit
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P_NO_CHANNEL },
      { symbol: "B", candles: candlesB, params: P_NO_CHANNEL },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 1, monthlyLossPct: 100 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(1);
    expect(gated.gateStats.demotedCount).toBe(0);
  });
});

describe("runPortfolioBacktest — portfolio gate: monthly loss throttle", () => {
  const H = 3_600_000;
  const BASE = Date.UTC(2024, 0, 15, 0, 0, 0);

  function lossFixture(): Candle[] {
    return [
      c(9.5, 8.5, 9, 100, BASE + 0 * H),
      c(9.5, 8.5, 9, 100, BASE + 1 * H),
      c(9.5, 8.5, 9, 100, BASE + 2 * H),
      c(12, 9, 12, 100, BASE + 3 * H),
      c(8, 5, 6, 100, BASE + 4 * H), // stop hit Jan 15 -> ~-2% realized this month
    ];
  }

  it("demotes a later-same-month entry once the monthly loss throttle is breached", () => {
    const candlesB = [
      c(9.5, 8.5, 9, 100, BASE + 5 * H),
      c(9.5, 8.5, 9, 100, BASE + 6 * H),
      c(9.5, 8.5, 9, 100, BASE + 7 * H),
      c(12, 9, 12, 100, BASE + 8 * H), // still Jan 15
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P_NO_CHANNEL },
      { symbol: "B", candles: candlesB, params: P_NO_CHANNEL },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 100, monthlyLossPct: 1 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(0);
    expect(gated.gateStats.demotedCount).toBe(1);
  });

  it("resets the monthly bucket in the next calendar month", () => {
    const febBase = Date.UTC(2024, 1, 1, 0, 0, 0);
    const candlesB = [
      c(9.5, 8.5, 9, 100, febBase + 0 * H),
      c(9.5, 8.5, 9, 100, febBase + 1 * H),
      c(9.5, 8.5, 9, 100, febBase + 2 * H),
      c(12, 9, 12, 100, febBase + 3 * H), // February, breakout entry
      c(8, 5, 6, 100, febBase + 4 * H), // stop hit
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P_NO_CHANNEL },
      { symbol: "B", candles: candlesB, params: P_NO_CHANNEL },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 100, monthlyLossPct: 1 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(1);
    expect(gated.gateStats.demotedCount).toBe(0);
  });
});
