import { atr, donchian, ema } from "./indicators.js";
import { allPassed, evaluateFilters } from "./filters.js";
import { positionSize } from "./sizing.js";
import {
  DEFAULT_PORTFOLIO_GATE,
  directionCounts,
  evaluatePortfolioGate,
  openRiskPct,
  type OpenPos,
  type PortfolioGateConfig,
  type PortfolioState,
} from "./portfolio.js";
import { NO_COSTS, type BacktestCosts, type BacktestStats, type Trade } from "./backtest.js";
import type { Candle, Params, Side } from "./types.js";

export interface SymbolInput {
  symbol: string;
  candles: Candle[];
  params: Params;
}

export interface PortfolioTrade extends Trade {
  symbol: string;
}

export interface PortfolioBacktestResult {
  trades: PortfolioTrade[];
  equityCurve: { time: number; equity: number }[];
  stats: BacktestStats;
  gateStats: { demotedCount: number; halvedCount: number };
}

interface SymbolState {
  symbol: string;
  candles: Candle[];
  params: Params;
  entryBands: ReturnType<typeof donchian>;
  exitBands: ReturnType<typeof donchian>;
  emaArr: ReturnType<typeof ema>;
  atrArr: ReturnType<typeof atr>;
  timeIndex: Map<number, number>;
  side: Side | null;
  entryPrice: number;
  effEntry: number;
  entryTime: number;
  stop: number;
  qty: number;
  initRisk: number;
  partialDone: boolean;
  realizedR: number;
  feeR: number;
  openFraction: number;
  barsInTrade: number;
  reached1R: boolean;
  lastCloseTime: number | null;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * Multi-symbol event-driven backtest over a single shared equity pool.
 * Mirrors runBacktest's per-bar rules exactly (same continue-based ordering)
 * but processes every symbol's candle on a merged global timeline so
 * evaluatePortfolioGate can see the true cross-symbol open-risk/loss state.
 */
export function runPortfolioBacktest(
  inputs: SymbolInput[],
  gateCfg: PortfolioGateConfig = DEFAULT_PORTFOLIO_GATE,
  startEquity = 10_000_000,
  costs: BacktestCosts = NO_COSTS,
  gateEnabled = true,
): PortfolioBacktestResult {
  const slip = costs.slippagePct / 100;
  const taker = costs.takerPct / 100;

  const states: SymbolState[] = inputs.map(({ symbol, candles, params }) => {
    const timeIndex = new Map<number, number>();
    candles.forEach((cd, i) => timeIndex.set(cd.openTime, i));
    return {
      symbol,
      candles,
      params,
      entryBands: donchian(candles, params.entryPeriod),
      exitBands: donchian(candles, params.exitPeriod),
      emaArr: ema(
        candles.map((cd) => cd.close),
        params.emaPeriod,
      ),
      atrArr: atr(candles, params.atrPeriod),
      timeIndex,
      side: null,
      entryPrice: 0,
      effEntry: 0,
      entryTime: 0,
      stop: 0,
      qty: 0,
      initRisk: 0,
      partialDone: false,
      realizedR: 0,
      feeR: 0,
      openFraction: 1,
      barsInTrade: 0,
      reached1R: false,
      lastCloseTime: null,
    };
  });

  const allTimes = Array.from(
    new Set(states.flatMap((s) => s.candles.map((cd) => cd.openTime))),
  ).sort((a, b) => a - b);

  let equity = startEquity;
  let peak = startEquity;
  let mdd = 0;
  const trades: PortfolioTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];
  let demotedCount = 0;
  let halvedCount = 0;

  let dailyKey = "";
  let dailyPnlPct = 0;
  let monthlyKey = "";
  let monthlyPnlPct = 0;

  const recordRealized = (time: number, pnlPct: number) => {
    const dk = dayKey(time);
    if (dk !== dailyKey) {
      dailyKey = dk;
      dailyPnlPct = 0;
    }
    dailyPnlPct += pnlPct * 100;

    const mk = monthKey(time);
    if (mk !== monthlyKey) {
      monthlyKey = mk;
      monthlyPnlPct = 0;
    }
    monthlyPnlPct += pnlPct * 100;
  };

  const closeTrade = (
    st: SymbolState,
    exitTime: number,
    exitPrice: number,
    exitReason: "stop" | "channel" | "time",
  ) => {
    const dir = st.side === "long" ? 1 : -1;
    const effExit = exitPrice * (1 - slip * dir);
    const remainingR =
      st.initRisk > 0 ? (((effExit - st.effEntry) * dir) / st.initRisk) * st.openFraction : 0;
    const finalFeeR = st.initRisk > 0 ? ((effExit * taker) / st.initRisk) * st.openFraction : 0;
    const r = st.realizedR + remainingR - st.feeR - finalFeeR;
    const pnlPct = (st.params.riskPct / 100) * r;
    equity *= 1 + pnlPct;
    peak = Math.max(peak, equity);
    mdd = Math.max(mdd, (peak - equity) / peak);
    trades.push({
      symbol: st.symbol,
      side: st.side as Side,
      entryTime: st.entryTime,
      entryPrice: st.entryPrice,
      exitTime,
      exitPrice,
      exitReason,
      rMultiple: r,
      pnlPct,
    });
    equityCurve.push({ time: exitTime, equity });
    recordRealized(exitTime, pnlPct);
    st.side = null;
    st.lastCloseTime = exitTime;
  };

  for (const t of allTimes) {
    for (const st of states) {
      const i = st.timeIndex.get(t);
      if (i === undefined || i === 0 || st.side === null) continue;
      const cd = st.candles[i];

      if (st.side === "long" && cd.low <= st.stop) {
        closeTrade(st, cd.openTime, st.stop, "stop");
        continue;
      }
      if (st.side === "short" && cd.high >= st.stop) {
        closeTrade(st, cd.openTime, st.stop, "stop");
        continue;
      }
      const ptp = st.params.partialTp;
      if (ptp && !st.partialDone) {
        const target =
          st.side === "long"
            ? st.entryPrice + ptp.atR * st.initRisk
            : st.entryPrice - ptp.atR * st.initRisk;
        const reached = st.side === "long" ? cd.high >= target : cd.low <= target;
        if (reached) {
          const dir = st.side === "long" ? 1 : -1;
          const effFill = target * (1 - slip * dir);
          st.realizedR += (((effFill - st.effEntry) * dir) / st.initRisk) * ptp.fraction;
          st.feeR += ((effFill * taker) / st.initRisk) * ptp.fraction;
          st.openFraction -= ptp.fraction;
          st.partialDone = true;
          if (ptp.moveStopToBreakeven) {
            st.stop =
              st.side === "long"
                ? Math.max(st.stop, st.entryPrice)
                : Math.min(st.stop, st.entryPrice);
          }
        }
      }
      const xb = st.exitBands[i];
      if (xb !== null) {
        if (st.side === "long" && cd.close < xb.lower) {
          closeTrade(st, cd.openTime, cd.close, "channel");
          continue;
        }
        if (st.side === "short" && cd.close > xb.upper) {
          closeTrade(st, cd.openTime, cd.close, "channel");
          continue;
        }
        if (st.side === "long" && xb.lower > st.stop) st.stop = xb.lower;
        if (st.side === "short" && xb.upper < st.stop) st.stop = xb.upper;
      }
      st.barsInTrade++;
      const oneRTarget =
        st.side === "long" ? st.entryPrice + st.initRisk : st.entryPrice - st.initRisk;
      if (st.side === "long" ? cd.high >= oneRTarget : cd.low <= oneRTarget) st.reached1R = true;
      if (st.params.timeStop && !st.reached1R && st.barsInTrade >= st.params.timeStop.bars) {
        closeTrade(st, cd.openTime, cd.close, "time");
        continue;
      }
    }

    for (const st of states) {
      const i = st.timeIndex.get(t);
      if (i === undefined || i === 0 || st.side !== null || st.lastCloseTime === t) continue;
      const cd = st.candles[i];
      const eb = st.entryBands[i];
      const emaV = st.emaArr[i];
      const atrV = st.atrArr[i];
      if (eb === null || emaV === null || atrV === null) continue;

      let dir: Side | null = null;
      const buf = (st.params.entryBufferAtr ?? 0) * atrV;
      if (cd.close > eb.upper + buf && cd.close > emaV) dir = "long";
      else if (cd.close < eb.lower - buf && cd.close < emaV) dir = "short";
      if (dir === null) continue;

      const filterCfg = {
        ...st.params.filters,
        funding: { ...st.params.filters.funding, on: false },
        oi: { ...st.params.filters.oi, on: false },
      };
      const checks = evaluateFilters(dir, st.candles.slice(0, i + 1), i, null, filterCfg);
      if (!allPassed(checks)) continue;

      let riskPct = st.params.riskPct;
      if (gateEnabled) {
        const openPositions: OpenPos[] = states
          .filter((s) => s.side !== null)
          .map((s) => ({
            side: s.side as Side,
            entryPrice: s.entryPrice,
            stop: s.stop,
            qty: s.qty,
          }));
        const counts = directionCounts(openPositions);
        const gateState: PortfolioState = {
          openRiskPct: openRiskPct(openPositions, equity),
          longCount: counts.long,
          shortCount: counts.short,
          realizedDailyPct: dailyKey === dayKey(t) ? dailyPnlPct : 0,
          realizedMonthlyPct: monthlyKey === monthKey(t) ? monthlyPnlPct : 0,
        };
        const gate = evaluatePortfolioGate(dir, gateState, gateCfg);
        if (gate.demote) {
          demotedCount++;
          continue;
        }
        // currently unreachable: evaluatePortfolioGate's monthly-throttle branch always
        // sets demote=true alongside halveRisk=true, and demote (checked above) already
        // skipped the entry via continue -- kept for live-engine parity / future-proofing
        if (gate.halveRisk) {
          halvedCount++;
          riskPct = riskPct / 2;
        }
      }

      const initRisk = st.params.stopMult * atrV;
      st.side = dir;
      st.entryPrice = cd.close;
      st.entryTime = cd.openTime;
      st.initRisk = initRisk;
      st.stop = dir === "long" ? cd.close - initRisk : cd.close + initRisk;
      st.effEntry = cd.close * (1 + slip * (dir === "long" ? 1 : -1));
      st.feeR = initRisk > 0 ? (st.effEntry * taker) / initRisk : 0;
      st.partialDone = false;
      st.realizedR = 0;
      st.openFraction = 1;
      st.barsInTrade = 0;
      st.reached1R = false;
      st.qty = positionSize(equity, riskPct, atrV, st.params.stopMult);
    }
  }

  const wins = trades.filter((t) => t.rMultiple > 0);
  const grossWin = wins.reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = trades.filter((t) => t.rMultiple <= 0).reduce((s, t) => s - t.rMultiple, 0);

  return {
    trades,
    equityCurve,
    gateStats: { demotedCount, halvedCount },
    stats: {
      n: trades.length,
      winRate: trades.length ? wins.length / trades.length : 0,
      avgR: trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      mdd,
      endEquity: equity,
    },
  };
}
