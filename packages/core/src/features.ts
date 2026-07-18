import { adx, atr, donchian, ema, rollingVwap, smaVolume } from "./indicators.js";
import type { Candle, Params, Side } from "./types.js";

/**
 * Feature snapshot at a signal's candle index. Captured at entry time and
 * stored for future Phase-2 meta-labeling (predict whether a signal reaches
 * +1R). This module only produces the snapshot — no model is trained here.
 * If not captured now it cannot be reconstructed later, so it is cheap-and-now.
 */
export interface FeatureSnapshot {
  dir: Side;
  close: number;
  atr: number | null;
  adx: number | null;
  volumeRatio: number | null; // breakout bar volume / trailing avg
  vwapDistPct: number | null; // (close - vwap) / vwap * 100
  emaDistPct: number | null; // (close - ema200) / ema200 * 100
  fundingRate: number | null;
  oiChangePct: number | null; // 24h open-interest change %, if available
  breakoutStrengthAtr: number | null; // (close - channel edge) / ATR
  dayOfWeek: number; // 0=Sun..6=Sat (UTC)
  utcHour: number; // 0..23
}

/**
 * Build the snapshot for candle index `i` (the just-closed breakout candle).
 * `dir` is the entry direction; `funding`/`oiChangePct` are external (may be null).
 * Reuses the same indicator functions as signal judgment — single source of truth.
 */
export function featureSnapshot(
  dir: Side,
  candles: Candle[],
  i: number,
  params: Params,
  funding: number | null,
  oiChangePct: number | null = null,
): FeatureSnapshot {
  const c = candles[i];
  const atrV = atr(candles, params.atrPeriod)[i];
  const adxV = adx(candles, params.filters.adx.period)[i];
  const volBase = smaVolume(candles, params.filters.volume.period)[i];
  const vwapV = rollingVwap(candles, params.filters.vwap.bars)[i];
  const emaV = ema(candles.map((x) => x.close), params.emaPeriod)[i];
  const band = donchian(candles, params.entryPeriod)[i];

  const edge = band ? (dir === "long" ? band.upper : band.lower) : null;
  const d = new Date(c.openTime);

  return {
    dir,
    close: c.close,
    atr: atrV,
    adx: adxV,
    volumeRatio: volBase && volBase > 0 ? c.volume / volBase : null,
    vwapDistPct: vwapV ? ((c.close - vwapV) / vwapV) * 100 : null,
    emaDistPct: emaV ? ((c.close - emaV) / emaV) * 100 : null,
    fundingRate: funding,
    oiChangePct,
    breakoutStrengthAtr: edge !== null && atrV ? (c.close - edge) / atrV : null,
    dayOfWeek: d.getUTCDay(),
    utcHour: d.getUTCHours(),
  };
}
