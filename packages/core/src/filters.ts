import { adx, rollingVwap, smaVolume } from "./indicators.js";
import type { Candle, FilterCheck, FilterConfig, Side } from "./types.js";

/**
 * Evaluate entry filters for a prospective breakout at candle index `i`
 * (the just-closed candle). Filters that are off pass automatically.
 * Funding rate `funding` is the current funding rate as a fraction
 * (0.0001 = 0.01%); null means unavailable -> pass with note.
 */
export function evaluateFilters(
  dir: Side,
  candles: Candle[],
  i: number,
  funding: number | null,
  cfg: FilterConfig,
  oiChangePct: number | null = null,
): FilterCheck[] {
  const checks: FilterCheck[] = [];

  // ADX trend strength
  if (cfg.adx.on) {
    const v = adx(candles, cfg.adx.period)[i];
    if (v === null) {
      checks.push({ name: "adx", passed: false, value: null, detail: "데이터 부족" });
    } else {
      checks.push({
        name: "adx",
        passed: v >= cfg.adx.min,
        value: v,
        detail: `ADX ${v.toFixed(1)} (기준 ${cfg.adx.min})`,
      });
    }
  } else {
    checks.push({ name: "adx", passed: true, value: null, detail: "off" });
  }

  // Volume confirmation
  if (cfg.volume.on) {
    const base = smaVolume(candles, cfg.volume.period)[i];
    if (base === null || base === 0) {
      checks.push({ name: "volume", passed: false, value: null, detail: "데이터 부족" });
    } else {
      const ratio = candles[i].volume / base;
      checks.push({
        name: "volume",
        passed: ratio >= cfg.volume.mult,
        value: ratio,
        detail: `거래량 ${ratio.toFixed(2)}x (기준 ${cfg.volume.mult}x)`,
      });
    }
  } else {
    checks.push({ name: "volume", passed: true, value: null, detail: "off" });
  }

  // Rolling VWAP side
  if (cfg.vwap.on) {
    const v = rollingVwap(candles, cfg.vwap.bars)[i];
    if (v === null) {
      checks.push({ name: "vwap", passed: false, value: null, detail: "데이터 부족" });
    } else {
      const close = candles[i].close;
      const passed = dir === "long" ? close > v : close < v;
      checks.push({
        name: "vwap",
        passed,
        value: v,
        detail: `종가 ${close} vs VWAP ${v.toFixed(2)}`,
      });
    }
  } else {
    checks.push({ name: "vwap", passed: true, value: null, detail: "off" });
  }

  // Funding rate crowding
  if (cfg.funding.on) {
    if (funding === null) {
      checks.push({
        name: "funding",
        passed: true,
        value: null,
        detail: "펀딩비 조회 불가 - 통과 처리",
      });
    } else {
      const blocked =
        dir === "long" ? funding > cfg.funding.maxAbs : funding < -cfg.funding.maxAbs;
      checks.push({
        name: "funding",
        passed: !blocked,
        value: funding,
        detail: `펀딩 ${(funding * 100).toFixed(4)}% (한도 ±${(cfg.funding.maxAbs * 100).toFixed(2)}%)`,
      });
    }
  } else {
    checks.push({ name: "funding", passed: true, value: null, detail: "off" });
  }

  // Open-interest confirmation: a genuine breakout coincides with rising OI
  // (new money) — for both directions. Null OI (unavailable) passes with a note.
  if (cfg.oi.on) {
    if (oiChangePct === null) {
      checks.push({ name: "oi", passed: true, value: null, detail: "OI 조회 불가 - 통과 처리" });
    } else {
      checks.push({
        name: "oi",
        passed: oiChangePct >= cfg.oi.minChangePct,
        value: oiChangePct,
        detail: `OI 24h ${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}% (기준 ≥${cfg.oi.minChangePct}%)`,
      });
    }
  } else {
    checks.push({ name: "oi", passed: true, value: null, detail: "off" });
  }

  return checks;
}

export function allPassed(checks: FilterCheck[]): boolean {
  return checks.every((c) => c.passed);
}
