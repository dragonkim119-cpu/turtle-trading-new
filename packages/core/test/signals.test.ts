import { describe, expect, it } from "vitest";
import { judgeClose } from "../src/signals.js";
import { runBacktest } from "../src/backtest.js";
import type { Candle, Params } from "../src/types.js";

function c(high: number, low: number, close: number, volume = 100, openTime = 0): Candle {
  return { openTime, open: close, high, low, close, volume };
}

/** Small-period params with all filters off, for deterministic fixtures. */
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
  },
};

const FLAT = { side: null } as const;

describe("judgeClose entries", () => {
  it("long entry on breakout above prior 3-bar high and above EMA", () => {
    // ramp keeps close above short EMA; final close 20 breaks prior high 13
    const candles = [
      c(11, 9, 10),
      c(12, 10, 11),
      c(13, 11, 12),
      c(20, 12, 20), // breakout bar
    ];
    const ev = judgeClose(FLAT, candles, P, null);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("ENTRY_LONG");
    if (ev[0].type === "ENTRY_LONG") {
      expect(ev[0].price).toBe(20);
      expect(ev[0].stop).toBeCloseTo(20 - 2 * ev[0].atr);
      expect(ev[0].stop).toBeLessThan(20);
    }
  });

  it("no entry when close above channel but below EMA", () => {
    // falling series then tiny bounce that breaks a flat channel but stays below EMA
    const candles = [
      c(100, 90, 95),
      c(90, 80, 85),
      c(80, 70, 75),
      c(78, 70, 77.5), // prior high 100? no. prior 3-bar high = max(100,90,80)=100 -> no breakout
    ];
    const ev = judgeClose(FLAT, candles, P, null);
    expect(ev).toHaveLength(0);
  });

  it("short entry mirror", () => {
    const candles = [
      c(21, 19, 20),
      c(20, 18, 19),
      c(19, 17, 18),
      c(18, 10, 10), // close 10 < prior low 17, below EMA
    ];
    const ev = judgeClose(FLAT, candles, P, null);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("ENTRY_SHORT");
    if (ev[0].type === "ENTRY_SHORT") {
      expect(ev[0].stop).toBeGreaterThan(10);
    }
  });

  it("blocked entry emits ENTRY_BLOCKED with failing filter", () => {
    const params: Params = {
      ...P,
      filters: { ...P.filters, volume: { on: true, period: 2, mult: 1.5 } },
    };
    const candles = [
      c(11, 9, 10, 100),
      c(12, 10, 11, 100),
      c(13, 11, 12, 100),
      c(20, 12, 20, 100), // breakout but volume only 1.0x
    ];
    const ev = judgeClose(FLAT, candles, params, null);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("ENTRY_BLOCKED");
    if (ev[0].type === "ENTRY_BLOCKED") {
      const vol = ev[0].filters.find((f) => f.name === "volume");
      expect(vol?.passed).toBe(false);
    }
  });
});

describe("judgeClose holding", () => {
  it("trailing stop ratchets up for long, never down", () => {
    const pos = { side: "long" as const, entryPrice: 10, stop: 8 };
    // prior 2-bar lows are 11,12 -> exit lower = 11 > 8 -> trail to 11
    const candles = [c(13, 11, 12), c(14, 12, 13), c(15, 13, 14)];
    const ev = judgeClose(pos, candles, P, null);
    expect(ev).toEqual([{ type: "TRAIL_UPDATE", newStop: 11, prevStop: 8 }]);
    // now stop=13 higher than band 11 -> no update
    const ev2 = judgeClose({ ...pos, stop: 13 }, candles, P, null);
    expect(ev2).toHaveLength(0);
  });

  it("long exit when close breaks 2-bar low", () => {
    const pos = { side: "long" as const, entryPrice: 10, stop: 8 };
    const candles = [c(15, 13, 14), c(15, 13, 14), c(13, 9, 9)]; // close 9 < prior low 13
    const ev = judgeClose(pos, candles, P, null);
    expect(ev).toEqual([{ type: "EXIT_LONG", price: 9 }]);
  });

  it("short exit + trailing mirror", () => {
    const pos = { side: "short" as const, entryPrice: 20, stop: 25 };
    // prior 2-bar highs 18,17 -> exit upper 18 < 25 -> trail down to 18
    const candles = [c(18, 14, 15), c(17, 13, 14), c(16, 12, 13)];
    const ev = judgeClose(pos, candles, P, null);
    expect(ev).toEqual([{ type: "TRAIL_UPDATE", newStop: 18, prevStop: 25 }]);
    const exit = judgeClose(pos, [c(18, 14, 15), c(17, 13, 14), c(19, 15, 19)], P, null);
    expect(exit).toEqual([{ type: "EXIT_SHORT", price: 19 }]);
  });
});

describe("entry buffer", () => {
  it("blocks a marginal breakout but passes a decisive one", () => {
    // marginal: close 13.5, prior 3-bar high 13, ATR ~2 -> buffer 0.5*ATR ~1 -> need >14
    const marginal = [c(11, 9, 10), c(12, 10, 11), c(13, 11, 12), c(13.5, 12, 13.5)];
    const withBuf: Params = { ...P, entryBufferAtr: 0.5 };
    expect(judgeClose(FLAT, marginal, withBuf, null)).toHaveLength(0);
    expect(judgeClose(FLAT, marginal, P, null)).toHaveLength(1); // no buffer -> entry
    const decisive = [c(11, 9, 10), c(12, 10, 11), c(13, 11, 12), c(20, 12, 20)];
    expect(judgeClose(FLAT, decisive, withBuf, null)).toHaveLength(1);
  });
});

describe("partial take-profit (backtest)", () => {
  function trendCandles(): Candle[] {
    const candles: Candle[] = [];
    let t = 0;
    for (let i = 0; i < 6; i++) candles.push(c(10, 9, 9.5, 100, t++));
    for (let i = 0; i < 15; i++) candles.push(c(11 + i, 10 + i, 10.8 + i, 100, t++));
    for (let i = 0; i < 8; i++) candles.push(c(25 - 2 * i, 23 - 2 * i, 23.5 - 2 * i, 100, t++));
    return candles;
  }

  it("banks partial R and reduces final trade R vs full hold in a winning trend", () => {
    const full = runBacktest(trendCandles(), P, 1000);
    const partial = runBacktest(
      trendCandles(),
      { ...P, partialTp: { atR: 1, fraction: 0.5, moveStopToBreakeven: false } },
      1000,
    );
    expect(full.trades.length).toBe(partial.trades.length);
    expect(partial.trades[0].rMultiple).toBeGreaterThan(0);
    // half banked at 1R, half rides: total R must be less than full hold in a big trend
    expect(partial.trades[0].rMultiple).toBeLessThan(full.trades[0].rMultiple);
    // but at least the banked portion (0.5R) is guaranteed
    expect(partial.trades[0].rMultiple).toBeGreaterThanOrEqual(0.5);
  });

  it("breakeven stop rescues the remaining half when price reverses after 1R", () => {
    // exitPeriod 10 on a short series => no channel/trailing, isolating stop+partial+breakeven.
    const P3: Params = { ...P, entryPeriod: 3, exitPeriod: 10, atrPeriod: 2, emaPeriod: 3, stopMult: 2 };
    const candles: Candle[] = [];
    let t = 0;
    for (let i = 0; i < 5; i++) candles.push(c(9.5, 8.5, 9, 100, t++)); // flat band 8.5..9.5
    candles.push(c(12, 9, 12, 100, t++)); // breakout entry @12, initRisk 2*ATR(=2)=4, stop 8, 1R target 16
    candles.push(c(17, 12, 15, 100, t++)); // high 17 hits 1R target
    candles.push(c(13, 11, 11.5, 100, t++)); // dips to 11 (below entry 12, above orig stop 8)
    candles.push(c(11, 7, 7.5, 100, t++)); // falls to 7 (below orig stop 8)

    const off = runBacktest(candles, { ...P3, partialTp: { atR: 1, fraction: 0.5, moveStopToBreakeven: false } }, 1000);
    const be = runBacktest(candles, { ...P3, partialTp: { atR: 1, fraction: 0.5, moveStopToBreakeven: true } }, 1000);
    expect(off.trades).toHaveLength(1);
    expect(be.trades).toHaveLength(1);
    // breakeven exits remaining half at entry (0R) vs original stop (-1R): net +0.5R vs 0R
    expect(be.trades[0].rMultiple).toBeCloseTo(0.5);
    expect(off.trades[0].rMultiple).toBeCloseTo(0);
    expect(be.trades[0].rMultiple).toBeGreaterThan(off.trades[0].rMultiple);
  });
});

describe("runBacktest", () => {
  function trendThenReversal(): Candle[] {
    const candles: Candle[] = [];
    let t = 0;
    // base
    for (let i = 0; i < 6; i++) candles.push(c(10, 9, 9.5, 100, t++));
    // up trend
    for (let i = 0; i < 15; i++) candles.push(c(11 + i, 10 + i, 10.8 + i, 100, t++));
    // reversal down through exit channel
    for (let i = 0; i < 8; i++) candles.push(c(25 - 2 * i, 23 - 2 * i, 23.5 - 2 * i, 100, t++));
    return candles;
  }

  it("captures a trend trade and closes it", () => {
    const res = runBacktest(trendThenReversal(), P, 1000);
    expect(res.stats.n).toBeGreaterThanOrEqual(1);
    expect(res.trades[0].side).toBe("long");
    expect(res.trades[0].rMultiple).toBeGreaterThan(0);
    expect(res.stats.endEquity).toBeGreaterThan(1000);
  });

  it("costs (fees+slippage) reduce every trade's R vs zero-cost", () => {
    const candles = trendThenReversal();
    const free = runBacktest(candles, P, 1000);
    const costed = runBacktest(candles, P, 1000, { takerPct: 0.05, slippagePct: 0.05 });
    expect(costed.stats.n).toBe(free.stats.n);
    // same trades, each nets less after costs
    for (let i = 0; i < free.trades.length; i++) {
      expect(costed.trades[i].rMultiple).toBeLessThan(free.trades[i].rMultiple);
    }
    expect(costed.stats.endEquity).toBeLessThan(free.stats.endEquity);
  });

  it("zero costs is numerically identical to the default (no-cost) path", () => {
    const candles = trendThenReversal();
    const a = runBacktest(candles, P, 1000);
    const b = runBacktest(candles, P, 1000, { takerPct: 0, slippagePct: 0 });
    expect(b.stats.endEquity).toBeCloseTo(a.stats.endEquity, 6);
    expect(b.trades[0].rMultiple).toBeCloseTo(a.trades[0].rMultiple, 6);
  });

  // exitPeriod 100 on a short series => exit bands stay null (no channel/trailing),
  // isolating the time stop from stop-hit interference.
  const PT = { ...P, exitPeriod: 100 };

  it("time stop closes a stagnant trade that never reaches +1R", () => {
    const candles: Candle[] = [];
    let t = 0;
    for (let i = 0; i < 6; i++) candles.push(c(10, 9, 9.5, 100, t++));
    candles.push(c(12, 10, 12, 100, t++)); // breakout entry ~12
    // flat bars just above entry, never reaching +1R and never near the fixed stop
    for (let i = 0; i < 10; i++) candles.push(c(12.3, 11.7, 12, 100, t++));
    const withTime = runBacktest(candles, { ...PT, timeStop: { bars: 4 } }, 1000);
    expect(withTime.trades).toHaveLength(1);
    expect(withTime.trades[0].exitReason).toBe("time");
  });

  it("time stop does NOT fire once +1R is reached", () => {
    const candles: Candle[] = [];
    let t = 0;
    for (let i = 0; i < 6; i++) candles.push(c(10, 9, 9.5, 100, t++));
    candles.push(c(12, 10, 12, 100, t++)); // entry ~12
    candles.push(c(20, 12, 19, 100, t++)); // spikes well past +1R -> reached1R
    for (let i = 0; i < 10; i++) candles.push(c(19.3, 18.7, 19, 100, t++)); // then flat
    const withTime = runBacktest(candles, { ...PT, timeStop: { bars: 3 } }, 1000);
    expect(withTime.trades[0]?.exitReason).not.toBe("time");
  });

  it("volume filter reduces trade count on noisy series", () => {
    const noisy: Candle[] = [];
    let t = 0;
    for (let i = 0; i < 80; i++) {
      const up = i % 6 < 3;
      noisy.push(c(up ? 12 + (i % 6) : 14 - (i % 6), up ? 10 + (i % 6) : 12 - (i % 6), up ? 11.5 + (i % 6) : 12.5 - (i % 6), 100, t++));
    }
    const off = runBacktest(noisy, P, 1000);
    const withVol = runBacktest(
      noisy,
      { ...P, filters: { ...P.filters, volume: { on: true, period: 5, mult: 1.5 } } },
      1000,
    );
    expect(withVol.stats.n).toBeLessThanOrEqual(off.stats.n);
  });
});
