import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest.js";
import { runPortfolioBacktest, type SymbolInput } from "../src/portfolio-backtest.js";
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
