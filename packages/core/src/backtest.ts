import { atr, donchian, ema } from "./indicators.js";
import { allPassed, evaluateFilters } from "./filters.js";
import type { Candle, Params, Side } from "./types.js";

export interface Trade {
  side: Side;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "stop" | "channel";
  rMultiple: number; // pnl / initial risk
  pnlPct: number; // pnl as % of equity at entry (risk-normalized sizing)
}

export interface BacktestStats {
  n: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  mdd: number; // max drawdown fraction, e.g. 0.23
  endEquity: number;
}

export interface BacktestResult {
  trades: Trade[];
  stats: BacktestStats;
}

/**
 * Replay the turtle rules over historical candles.
 * Mirrors signals.ts judgeClose logic with precomputed indicator arrays
 * (recomputing per bar would be O(n^2)). Funding filter is skipped
 * (no historical funding series) — its cfg.on is ignored here.
 *
 * Sizing: fixed-fractional risk. Each trade risks params.riskPct% of current
 * equity; stop fill assumed at stop price (conservative intrabar model:
 * stop checked against bar extremes before close-based exit).
 */
export function runBacktest(
  candles: Candle[],
  params: Params,
  startEquity = 10_000_000,
): BacktestResult {
  const entryBands = donchian(candles, params.entryPeriod);
  const exitBands = donchian(candles, params.exitPeriod);
  const emaArr = ema(
    candles.map((c) => c.close),
    params.emaPeriod,
  );
  const atrArr = atr(candles, params.atrPeriod);

  const trades: Trade[] = [];
  let equity = startEquity;
  let peak = startEquity;
  let mdd = 0;

  let side: Side | null = null;
  let entryPrice = 0;
  let entryTime = 0;
  let stop = 0;
  let initRisk = 0; // price distance at entry
  let partialDone = false;
  let realizedR = 0; // R already banked by partial take-profit
  let openFraction = 1; // fraction of the position still open

  const closeTrade = (
    exitTime: number,
    exitPrice: number,
    exitReason: "stop" | "channel",
  ) => {
    const dir = side === "long" ? 1 : -1;
    const move = (exitPrice - entryPrice) * dir;
    const r = realizedR + (initRisk > 0 ? (move / initRisk) * openFraction : 0);
    const pnlPct = (params.riskPct / 100) * r;
    equity *= 1 + pnlPct;
    peak = Math.max(peak, equity);
    mdd = Math.max(mdd, (peak - equity) / peak);
    trades.push({
      side: side as Side,
      entryTime,
      entryPrice,
      exitTime,
      exitPrice,
      exitReason,
      rMultiple: r,
      pnlPct,
    });
    side = null;
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];

    if (side !== null) {
      // 1) intrabar stop (checked before partial TP — conservative when both hit in one bar)
      if (side === "long" && c.low <= stop) {
        closeTrade(c.openTime, stop, "stop");
        continue;
      }
      if (side === "short" && c.high >= stop) {
        closeTrade(c.openTime, stop, "stop");
        continue;
      }
      // 1.5) partial take-profit at entry ± atR × initRisk
      const ptp = params.partialTp;
      if (ptp && !partialDone) {
        const target =
          side === "long" ? entryPrice + ptp.atR * initRisk : entryPrice - ptp.atR * initRisk;
        const reached = side === "long" ? c.high >= target : c.low <= target;
        if (reached) {
          realizedR += ptp.atR * ptp.fraction;
          openFraction -= ptp.fraction;
          partialDone = true;
          if (ptp.moveStopToBreakeven) {
            // ratchet stop to breakeven, never loosen an already-favorable trail
            stop = side === "long" ? Math.max(stop, entryPrice) : Math.min(stop, entryPrice);
          }
        }
      }
      // 2) close-based channel exit
      const xb = exitBands[i];
      if (xb !== null) {
        if (side === "long" && c.close < xb.lower) {
          closeTrade(c.openTime, c.close, "channel");
          continue;
        }
        if (side === "short" && c.close > xb.upper) {
          closeTrade(c.openTime, c.close, "channel");
          continue;
        }
        // 3) trailing ratchet
        if (side === "long" && xb.lower > stop) stop = xb.lower;
        if (side === "short" && xb.upper < stop) stop = xb.upper;
      }
      continue;
    }

    // Flat: entries
    const eb = entryBands[i];
    const emaV = emaArr[i];
    const atrV = atrArr[i];
    if (eb === null || emaV === null || atrV === null) continue;

    let dir: Side | null = null;
    const buf = (params.entryBufferAtr ?? 0) * atrV;
    if (c.close > eb.upper + buf && c.close > emaV) dir = "long";
    else if (c.close < eb.lower - buf && c.close < emaV) dir = "short";
    if (dir === null) continue;

    const cfg = {
      ...params.filters,
      funding: { ...params.filters.funding, on: false },
    };
    const checks = evaluateFilters(dir, candles.slice(0, i + 1), i, null, cfg);
    if (!allPassed(checks)) continue;

    side = dir;
    entryPrice = c.close;
    entryTime = c.openTime;
    initRisk = params.stopMult * atrV;
    stop = dir === "long" ? c.close - initRisk : c.close + initRisk;
    partialDone = false;
    realizedR = 0;
    openFraction = 1;
  }

  const wins = trades.filter((t) => t.rMultiple > 0);
  const grossWin = wins.reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = trades
    .filter((t) => t.rMultiple <= 0)
    .reduce((s, t) => s - t.rMultiple, 0);

  return {
    trades,
    stats: {
      n: trades.length,
      winRate: trades.length ? wins.length / trades.length : 0,
      avgR: trades.length
        ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length
        : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      mdd,
      endEquity: equity,
    },
  };
}
