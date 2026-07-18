import { describe, expect, it } from "vitest";
import { allPassed, evaluateFilters } from "../src/filters.js";
import { positionSize } from "../src/sizing.js";
import type { Candle, FilterConfig } from "../src/types.js";

function c(high: number, low: number, close: number, volume = 100): Candle {
  return { openTime: 0, open: close, high, low, close, volume };
}

const OFF: FilterConfig = {
  adx: { on: false, period: 14, min: 20 },
  volume: { on: false, period: 20, mult: 1.5 },
  vwap: { on: false, bars: 30 },
  funding: { on: false, maxAbs: 0.001 },
};

describe("evaluateFilters", () => {
  it("all off -> all pass", () => {
    const candles = [c(1, 0, 1), c(1, 0, 1)];
    const checks = evaluateFilters("long", candles, 1, null, OFF);
    expect(checks).toHaveLength(4);
    expect(allPassed(checks)).toBe(true);
  });

  it("volume filter blocks weak breakout and passes strong one", () => {
    const cfg: FilterConfig = { ...OFF, volume: { on: true, period: 2, mult: 1.5 } };
    const weak = [c(1, 0, 1, 100), c(1, 0, 1, 100), c(1, 0, 1, 120)];
    const strong = [c(1, 0, 1, 100), c(1, 0, 1, 100), c(1, 0, 1, 200)];
    expect(allPassed(evaluateFilters("long", weak, 2, null, cfg))).toBe(false);
    expect(allPassed(evaluateFilters("long", strong, 2, null, cfg))).toBe(true);
  });

  it("vwap filter direction-aware", () => {
    const cfg: FilterConfig = { ...OFF, vwap: { on: true, bars: 2 } };
    // vwap idx2 = 3.5 (from indicator test fixture); close 5 above -> long ok, short blocked
    const candles = [c(2, 0, 1, 10), c(4, 2, 3, 30), c(6, 4, 5, 10)];
    expect(allPassed(evaluateFilters("long", candles, 2, null, cfg))).toBe(true);
    expect(allPassed(evaluateFilters("short", candles, 2, null, cfg))).toBe(false);
  });

  it("funding blocks crowded side only; null funding passes", () => {
    const cfg: FilterConfig = { ...OFF, funding: { on: true, maxAbs: 0.001 } };
    const candles = [c(1, 0, 1), c(1, 0, 1)];
    expect(allPassed(evaluateFilters("long", candles, 1, 0.002, cfg))).toBe(false);
    expect(allPassed(evaluateFilters("short", candles, 1, 0.002, cfg))).toBe(true);
    expect(allPassed(evaluateFilters("short", candles, 1, -0.002, cfg))).toBe(false);
    expect(allPassed(evaluateFilters("long", candles, 1, null, cfg))).toBe(true);
  });

  it("adx filter blocks when insufficient data", () => {
    const cfg: FilterConfig = { ...OFF, adx: { on: true, period: 14, min: 20 } };
    const candles = [c(1, 0, 1), c(1, 0, 1)];
    expect(allPassed(evaluateFilters("long", candles, 1, null, cfg))).toBe(false);
  });
});

describe("positionSize", () => {
  it("computes 2% rule quantity", () => {
    // equity 100M KRW, risk 2% = 2M; stop distance = 720*2 = 1440 -> qty 1388.88..
    expect(positionSize(100_000_000, 2, 720, 2)).toBeCloseTo(1388.888, 2);
  });
  it("returns 0 on invalid input", () => {
    expect(positionSize(0, 2, 720, 2)).toBe(0);
    expect(positionSize(100, 2, 0, 2)).toBe(0);
  });
});
