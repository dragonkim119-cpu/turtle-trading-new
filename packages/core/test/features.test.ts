import { describe, expect, it } from "vitest";
import { featureSnapshot } from "../src/features.js";
import { DEFAULT_PARAMS, type Candle, type Params } from "../src/types.js";

function c(high: number, low: number, close: number, volume = 100, openTime = 0): Candle {
  return { openTime, open: close, high, low, close, volume };
}

const P: Params = {
  ...DEFAULT_PARAMS,
  entryPeriod: 3,
  atrPeriod: 2,
  emaPeriod: 3,
  filters: {
    ...DEFAULT_PARAMS.filters,
    adx: { on: true, period: 2, min: 20 },
    volume: { on: true, period: 2, mult: 1.5 },
    vwap: { on: true, bars: 2 },
  },
};

describe("featureSnapshot", () => {
  it("captures breakout strength, volume ratio, distances at the signal candle", () => {
    // 5 flat-ish bars then a breakout bar
    const candles = [
      c(10, 9, 9.5, 100, 0),
      c(10, 9, 9.5, 100, 1),
      c(10, 9, 9.5, 100, 2),
      c(10, 9, 9.5, 100, 3),
      c(14, 10, 14, 300, 4), // breakout: close 14, prior-3 high = 10, volume 3x
    ];
    const i = candles.length - 1;
    const snap = featureSnapshot("long", candles, i, P, 0.0001, 2.5);

    expect(snap.dir).toBe("long");
    expect(snap.close).toBe(14);
    // breakout strength = (close - prior3High) / ATR = (14-10)/ATR
    expect(snap.breakoutStrengthAtr).not.toBeNull();
    expect(snap.breakoutStrengthAtr!).toBeGreaterThan(0);
    // volume ratio = 300 / avg(prior 2 = 100,100) = 3
    expect(snap.volumeRatio).toBeCloseTo(3);
    expect(snap.fundingRate).toBe(0.0001);
    expect(snap.oiChangePct).toBe(2.5);
    // emaDist positive (close above short EMA)
    expect(snap.emaDistPct!).toBeGreaterThan(0);
    expect(snap.utcHour).toBe(0);
    expect(snap.dayOfWeek).toBe(4); // 1970-01-01 was a Thursday
  });

  it("null-safe when indicators lack data", () => {
    const candles = [c(10, 9, 9.5), c(10, 9, 9.5)];
    const snap = featureSnapshot("long", candles, 1, P, null);
    expect(snap.fundingRate).toBeNull();
    expect(snap.oiChangePct).toBeNull();
    expect(snap.breakoutStrengthAtr).toBeNull();
  });
});
