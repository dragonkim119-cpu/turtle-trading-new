import { describe, expect, it } from "vitest";
import { DEFAULT_VOL_GUARD, oneMinAnomaly } from "../src/volatility.js";
import type { Candle } from "../src/types.js";

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ openTime: i * 60_000, open: c, high: c, low: c, close: c, volume: 100 }));
}

describe("oneMinAnomaly", () => {
  it("no spike on calm series", () => {
    // ~0.1% wiggles
    const closes = [100, 100.1, 99.95, 100.05, 100.0, 100.1, 99.9, 100.0];
    const r = oneMinAnomaly(series(closes), DEFAULT_VOL_GUARD);
    expect(r.spike).toBe(false);
  });

  it("spikes on a sudden large drop (absolute floor)", () => {
    const closes = [100, 100.1, 99.95, 100.05, 100.0, 100.1, 99.9, 97.5]; // -2.4%
    const r = oneMinAnomaly(series(closes), DEFAULT_VOL_GUARD);
    expect(r.spike).toBe(true);
    expect(r.pct).toBeLessThan(-1.5);
  });

  it("spikes on a large pump", () => {
    const closes = [100, 100.05, 99.98, 100.02, 100, 100.03, 99.99, 103]; // +3%
    const r = oneMinAnomaly(series(closes), DEFAULT_VOL_GUARD);
    expect(r.spike).toBe(true);
    expect(r.pct).toBeGreaterThan(1.5);
  });

  it("spikes on k-sigma move even below absolute floor", () => {
    // tiny ±0.05% baseline (stdev ~0.05%), then a 0.8% move: <1.5% floor but >4σ
    const closes = [100, 100.05, 99.95, 100.05, 99.95, 100.05, 99.95, 100.75];
    const cfg = { ...DEFAULT_VOL_GUARD, absPct: 1.5, k: 4 };
    const r = oneMinAnomaly(series(closes), cfg);
    expect(Math.abs(r.pct)).toBeLessThan(1.5); // confirm it's below the absolute floor
    expect(r.spike).toBe(true); // fired via k-sigma
  });

  it("returns no spike when insufficient data", () => {
    expect(oneMinAnomaly(series([100, 101]), DEFAULT_VOL_GUARD).spike).toBe(false);
  });
});
