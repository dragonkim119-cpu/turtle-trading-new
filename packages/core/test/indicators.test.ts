import { describe, expect, it } from "vitest";
import {
  adx,
  atr,
  donchian,
  ema,
  rollingVwap,
  smaVolume,
} from "../src/indicators.js";
import type { Candle } from "../src/types.js";

function c(
  high: number,
  low: number,
  close: number,
  volume = 100,
  openTime = 0,
): Candle {
  return { openTime, open: close, high, low, close, volume };
}

describe("ema", () => {
  it("seeds with SMA then smooths (period 3, k=0.5)", () => {
    // seed at idx2 = (1+2+3)/3 = 2; idx3 = 4*.5 + 2*.5 = 3; idx4 = 5*.5 + 3*.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("returns all null when not enough data", () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });
});

describe("atr", () => {
  it("computes Wilder ATR (constant TR)", () => {
    const candles = [c(10, 0, 5), c(10, 0, 5), c(10, 0, 5), c(10, 0, 5)];
    const out = atr(candles, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(10);
    expect(out[3]).toBeCloseTo(10);
  });
  it("includes gap in true range", () => {
    // prev close 5, next bar high 20 low 15 -> TR = max(5, |20-5|, |15-5|) = 15
    const candles = [c(10, 0, 5), c(20, 15, 18), c(20, 15, 18)];
    const out = atr(candles, 2);
    // TRs: [15, 5] -> seed at idx2 = 10
    expect(out[2]).toBeCloseTo(10);
  });
});

describe("donchian (prior N bars, excludes current)", () => {
  it("gives extremes of previous N bars", () => {
    const candles = [c(1, 0, 1), c(2, 1, 2), c(3, 2, 3), c(4, 3, 4)];
    const out = donchian(candles, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toEqual({ upper: 2, lower: 0 });
    expect(out[3]).toEqual({ upper: 3, lower: 1 });
  });
  it("current bar high does not count toward its own band", () => {
    const candles = [c(1, 0, 1), c(1, 0, 1), c(100, 0, 100)];
    const out = donchian(candles, 2);
    expect(out[2]).toEqual({ upper: 1, lower: 0 }); // breakout: close 100 > upper 1
  });
});

describe("adx", () => {
  it("is high in a strong trend and low in chop", () => {
    const trend: Candle[] = [];
    for (let i = 0; i < 60; i++) trend.push(c(10 + i, 9 + i, 9.5 + i));
    const chop: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const up = i % 2 === 0;
      chop.push(c(up ? 11 : 10.5, up ? 10 : 9.5, up ? 10.8 : 9.8));
    }
    const at = adx(trend, 14)[59]!;
    const ac = adx(chop, 14)[59]!;
    expect(at).toBeGreaterThan(25);
    expect(ac).toBeLessThan(20);
    expect(at).toBeGreaterThan(ac);
  });
  it("null before 2*period", () => {
    const trend: Candle[] = [];
    for (let i = 0; i < 29; i++) trend.push(c(10 + i, 9 + i, 9.5 + i));
    const out = adx(trend, 14);
    expect(out[27]).toBeNull();
    expect(out[28]).not.toBeNull();
  });
});

describe("rollingVwap", () => {
  it("volume-weighted typical price over trailing window", () => {
    const candles = [c(2, 0, 1, 10), c(4, 2, 3, 30), c(6, 4, 5, 10)];
    const out = rollingVwap(candles, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo((1 * 10 + 3 * 30) / 40); // 2.5
    expect(out[2]).toBeCloseTo((3 * 30 + 5 * 10) / 40); // 3.5
  });
});

describe("smaVolume (excludes current bar)", () => {
  it("averages prior N volumes", () => {
    const candles = [c(1, 0, 1, 10), c(1, 0, 1, 20), c(1, 0, 1, 30), c(1, 0, 1, 40)];
    const out = smaVolume(candles, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(15);
    expect(out[3]).toBe(25);
  });
});
