import type { Candle } from "./types.js";

export interface VolGuardConfig {
  on: boolean;
  bars: number; // baseline window of 1m candles (default 30)
  k: number; // spike if |move| > k * baseline stdev (default 4)
  absPct: number; // OR spike if |move| >= this absolute % (default 1.5)
  cooldownMin: number; // entry cooldown after a spike, minutes (default 20)
}

export const DEFAULT_VOL_GUARD: VolGuardConfig = {
  on: true,
  bars: 30,
  k: 4,
  absPct: 1.5,
  cooldownMin: 20,
};

export interface VolAnomaly {
  spike: boolean;
  pct: number; // latest 1m close-to-close % move (signed)
  baselinePct: number; // stdev of recent 1m % moves
}

/**
 * Detect an abnormal 1-minute move on the latest closed 1m candle.
 * Baseline = stdev of the prior `bars` one-minute returns. A spike fires when
 * the latest |move| exceeds k×baseline OR an absolute % floor — the floor keeps
 * it from firing on tiny moves during dead-quiet baselines.
 * This is DEFENSIVE only: it never produces a trade signal.
 */
export function oneMinAnomaly(recent1m: Candle[], cfg: VolGuardConfig): VolAnomaly {
  const n = recent1m.length;
  if (n < 3) return { spike: false, pct: 0, baselinePct: 0 };

  // close-to-close % returns
  const rets: number[] = [];
  for (let i = 1; i < n; i++) {
    const prev = recent1m[i - 1].close;
    if (prev > 0) rets.push(((recent1m[i].close - prev) / prev) * 100);
  }
  if (rets.length < 2) return { spike: false, pct: 0, baselinePct: 0 };

  const latest = rets[rets.length - 1];
  const baseline = rets.slice(0, -1).slice(-cfg.bars); // prior window, excludes latest
  const mean = baseline.reduce((s, x) => s + x, 0) / baseline.length;
  const variance = baseline.reduce((s, x) => s + (x - mean) ** 2, 0) / baseline.length;
  const stdev = Math.sqrt(variance);

  const spike = Math.abs(latest) >= cfg.absPct || (stdev > 0 && Math.abs(latest) > cfg.k * stdev);
  return { spike, pct: latest, baselinePct: stdev };
}
