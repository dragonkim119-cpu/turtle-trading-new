import type { Candle } from "./types.js";

/** Simple EMA over a value series. First (period-1) entries are null; seed is SMA of first `period` values. */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function trueRange(c: Candle, prevClose: number | null): number {
  if (prevClose === null) return c.high - c.low;
  return Math.max(
    c.high - c.low,
    Math.abs(c.high - prevClose),
    Math.abs(c.low - prevClose),
  );
}

/** Wilder-smoothed ATR. out[i] valid from index `period` (needs period TRs after first candle). */
export function atr(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  // TR series starting at index 1 (needs prev close)
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1].close));
  }
  // seed: SMA of first `period` TRs -> corresponds to candle index `period`
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}

export interface DonchianBand {
  upper: number;
  lower: number;
}

/**
 * Donchian channel of the PRIOR `period` bars (excludes current bar), so a
 * breakout test is simply `close[i] > upper[i]`. out[i] is null until there
 * are `period` bars before index i.
 */
export function donchian(
  candles: Candle[],
  period: number,
): (DonchianBand | null)[] {
  const out: (DonchianBand | null)[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let upper = -Infinity;
    let lower = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > upper) upper = candles[j].high;
      if (candles[j].low < lower) lower = candles[j].low;
    }
    out[i] = { upper, lower };
  }
  return out;
}

/** Wilder ADX. Valid from index 2*period. */
export function adx(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < 2 * period + 1) return out;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(trueRange(candles[i], candles[i - 1].close));
  }

  // Wilder smoothing of DM and TR
  let smTR = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 0; i < period; i++) {
    smTR += trs[i];
    smPlus += plusDM[i];
    smMinus += minusDM[i];
  }
  const dxs: number[] = [];
  const pushDx = () => {
    const pdi = smTR === 0 ? 0 : (100 * smPlus) / smTR;
    const mdi = smTR === 0 ? 0 : (100 * smMinus) / smTR;
    const sum = pdi + mdi;
    dxs.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum);
  };
  pushDx(); // corresponds to candle index `period`
  for (let i = period; i < trs.length; i++) {
    smTR = smTR - smTR / period + trs[i];
    smPlus = smPlus - smPlus / period + plusDM[i];
    smMinus = smMinus - smMinus / period + minusDM[i];
    pushDx(); // candle index i+1
  }
  // ADX = Wilder average of DX; first ADX at dx index period-1 -> candle index 2*period
  let adxPrev = 0;
  for (let i = 0; i < period; i++) adxPrev += dxs[i];
  adxPrev /= period;
  out[2 * period] = adxPrev;
  for (let i = period; i < dxs.length; i++) {
    adxPrev = (adxPrev * (period - 1) + dxs[i]) / period;
    out[i + period + 1] = adxPrev;
  }
  return out;
}

/** Rolling VWAP over trailing `bars` candles (inclusive of current). typical price = (h+l+c)/3. */
export function rollingVwap(
  candles: Candle[],
  bars: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
    if (i >= bars) {
      const old = candles[i - bars];
      const oldTp = (old.high + old.low + old.close) / 3;
      pv -= oldTp * old.volume;
      vol -= old.volume;
    }
    if (i >= bars - 1) {
      out[i] = vol === 0 ? null : pv / vol;
    }
  }
  return out;
}

/** SMA of volume over trailing `period` bars EXCLUDING current bar (baseline to compare breakout bar against). */
export function smaVolume(
  candles: Candle[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i >= period) {
      out[i] = sum / period; // avg of volumes [i-period, i-1]
      sum -= candles[i - period].volume;
    }
    sum += candles[i].volume;
  }
  return out;
}
