import { atr, donchian, ema } from "./indicators.js";
import { allPassed, evaluateFilters } from "./filters.js";
import type { Candle, Params, PosCtx, Side, SignalEvent } from "./types.js";

const ONE_DAY_MS = 86_400_000;

/**
 * Resolve the 1d regime direction as of a 4h (or any lower-tf) candle's
 * openTime: the last CLOSED daily bar's close vs its EMA(emaPeriod). Never
 * references a daily bar still in progress (look-ahead guard) — a bar counts
 * as closed only once a full day has elapsed since its own openTime.
 */
export function resolveRegimeDir(
  higherTfCandles: Candle[] | undefined,
  atOpenTime: number,
  emaPeriod: number,
): Side | null {
  if (!higherTfCandles || higherTfCandles.length === 0) return null;
  let lastClosedIdx = -1;
  for (let j = 0; j < higherTfCandles.length; j++) {
    if (higherTfCandles[j].openTime + ONE_DAY_MS <= atOpenTime) lastClosedIdx = j;
    else break; // candles are sorted ascending by openTime
  }
  if (lastClosedIdx < 0) return null;
  const closes = higherTfCandles.slice(0, lastClosedIdx + 1).map((c) => c.close);
  const emaArr = ema(closes, emaPeriod);
  const emaV = emaArr[emaArr.length - 1];
  if (emaV === null) return null;
  const close = higherTfCandles[lastClosedIdx].close;
  return close >= emaV ? "long" : "short";
}

/**
 * Judge the just-closed candle (last element of `candles`).
 * Pure function: no side effects. Returns zero or more events.
 *
 * Rules (see design spec §4):
 * - Entries: close beyond prior entryPeriod Donchian extreme, on the correct
 *   side of EMA(emaPeriod), with all enabled filters passing. Filters gate
 *   entries only.
 * - Initial stop: entry -/+ stopMult * ATR(atrPeriod).
 * - Trailing: exitPeriod opposite extreme ratchets the stop (never loosens).
 * - Exit: close beyond exitPeriod opposite extreme.
 * - Stop-loss touch is judged intraday elsewhere (stop monitor), not here.
 */
export function judgeClose(
  pos: PosCtx,
  candles: Candle[],
  params: Params,
  funding: number | null,
  oiChangePct: number | null = null,
  higherTfCandles?: Candle[],
): SignalEvent[] {
  const i = candles.length - 1;
  const events: SignalEvent[] = [];
  if (i < 1) return events;

  const close = candles[i].close;
  const entryBands = donchian(candles, params.entryPeriod);
  const exitBands = donchian(candles, params.exitPeriod);
  const emaArr = ema(
    candles.map((c) => c.close),
    params.emaPeriod,
  );
  const atrArr = atr(candles, params.atrPeriod);

  const entryBand = entryBands[i];
  const exitBand = exitBands[i];
  const emaV = emaArr[i];
  const atrV = atrArr[i];

  if (pos.side === null) {
    // Flat: look for entries. Need EMA + entry band + ATR available.
    if (entryBand === null || emaV === null || atrV === null) return events;

    const buf = (params.entryBufferAtr ?? 0) * atrV;
    if (close > entryBand.upper + buf && close > emaV) {
      const regimeDir = resolveRegimeDir(higherTfCandles, candles[i].openTime, params.filters.regime.emaPeriod);
      const checks = evaluateFilters("long", candles, i, funding, params.filters, oiChangePct, regimeDir);
      if (allPassed(checks)) {
        events.push({
          type: "ENTRY_LONG",
          price: close,
          stop: close - params.stopMult * atrV,
          atr: atrV,
          filters: checks,
        });
      } else {
        events.push({ type: "ENTRY_BLOCKED", dir: "long", price: close, filters: checks });
      }
    } else if (close < entryBand.lower - buf && close < emaV) {
      const regimeDir = resolveRegimeDir(higherTfCandles, candles[i].openTime, params.filters.regime.emaPeriod);
      const checks = evaluateFilters("short", candles, i, funding, params.filters, oiChangePct, regimeDir);
      if (allPassed(checks)) {
        events.push({
          type: "ENTRY_SHORT",
          price: close,
          stop: close + params.stopMult * atrV,
          atr: atrV,
          filters: checks,
        });
      } else {
        events.push({ type: "ENTRY_BLOCKED", dir: "short", price: close, filters: checks });
      }
    }
    return events;
  }

  // Holding a position: exit first, else trailing update.
  if (exitBand === null) return events;

  if (pos.side === "long") {
    if (close < exitBand.lower) {
      events.push({ type: "EXIT_LONG", price: close });
      return events;
    }
    if (pos.stop !== undefined && exitBand.lower > pos.stop) {
      events.push({ type: "TRAIL_UPDATE", newStop: exitBand.lower, prevStop: pos.stop });
    }
  } else {
    if (close > exitBand.upper) {
      events.push({ type: "EXIT_SHORT", price: close });
      return events;
    }
    if (pos.stop !== undefined && exitBand.upper < pos.stop) {
      events.push({ type: "TRAIL_UPDATE", newStop: exitBand.upper, prevStop: pos.stop });
    }
  }
  return events;
}
