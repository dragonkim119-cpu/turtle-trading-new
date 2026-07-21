# 포트폴리오 분산 백테스트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 다심볼 공유 equity 이벤트 드리븐 포트폴리오 백테스트 엔진을 추가하고, 실시간 엔진과 동일한 `evaluatePortfolioGate`를 백테스트에 실제로 적용(진입 스킵)해 그 효과를 검증하는 CLI를 만든다.

**Architecture:** `packages/core/src/portfolio-backtest.ts`에 새 순수 함수 `runPortfolioBacktest`를 추가한다. 심볼별로 `donchian`/`ema`/`atr`(indicators.ts)를 사전계산하고, 전 심볼 `openTime` 합집합을 시간순으로 순회하며 각 타임스텝마다 (1) 전 심볼 청산판정 → 공유 equity·일/월 실현손익 버킷 갱신 → (2) 전 심볼 진입판정 → `evaluatePortfolioGate`(portfolio.ts) 호출 → demote 시 스킵/halveRisk 시 절반사이징. 사이징은 `positionSize`(sizing.ts) 재사용. 청산 R/수수료 계산 공식은 `backtest.ts`의 `runBacktest`와 동일(의도적으로 유사 로직 유지 — 멀티심볼 상태머신이라 클로저 구조상 공유 추출 안 함, 공식은 반드시 동일하게 유지).

**Tech Stack:** TypeScript(ESM), vitest, tsx(CLI 실행), pnpm workspace

## Global Constraints

- ESM: 소스는 `.ts`, 임포트는 `.js` 확장자 (`import { x } from "./y.js"`) — CLAUDE.md
- TDD: 실패하는 테스트 먼저 작성 후 구현 — CLAUDE.md
- 핵심 불변식: 지표(donchian/ema/atr/adx/vwap/volume) 계산은 `packages/core`의 기존 함수만 재사용, 재구현 금지 — CLAUDE.md
- funding/OI 필터는 과거 데이터 부재로 백테스트에서 항상 강제 off — CLAUDE.md, 기존 `runBacktest` 관례와 동일
- 커밋: Conventional Commits, 각 태스크 끝에 커밋 (push는 사용자 지시 없으면 하지 않음)
- 테스트 파일은 자체적으로 `c()` 헬퍼와 파라미터 픽스처를 정의 (기존 `signals.test.ts`/`portfolio.test.ts` 관례 — 파일 간 공유 안 함)

---

### Task 1: 포트폴리오 백테스트 엔진 (게이트 비활성 경로)

**Files:**
- Create: `packages/core/src/portfolio-backtest.ts`
- Test: `packages/core/test/portfolio-backtest.test.ts`

**Interfaces:**
- Consumes: `donchian`, `ema`, `atr`(`./indicators.js`), `allPassed`, `evaluateFilters`(`./filters.js`), `positionSize`(`./sizing.js`), `DEFAULT_PORTFOLIO_GATE`, `evaluatePortfolioGate`, `openRiskPct`, `directionCounts`, `type OpenPos`, `type PortfolioGateConfig`, `type PortfolioState`(`./portfolio.js`), `NO_COSTS`, `type BacktestCosts`, `type BacktestStats`, `type Trade`(`./backtest.js`), `type Candle`, `type Params`, `type Side`(`./types.js`)
- Produces: `runPortfolioBacktest(inputs: SymbolInput[], gateCfg?: PortfolioGateConfig, startEquity?: number, costs?: BacktestCosts, gateEnabled?: boolean): PortfolioBacktestResult`, `interface SymbolInput { symbol: string; candles: Candle[]; params: Params }`, `interface PortfolioTrade extends Trade { symbol: string }`, `interface PortfolioBacktestResult { trades: PortfolioTrade[]; equityCurve: { time: number; equity: number }[]; stats: BacktestStats; gateStats: { demotedCount: number; halvedCount: number } }`

- [ ] **Step 1: 실패하는 테스트부터 작성**

`packages/core/test/portfolio-backtest.test.ts` 신규 생성:

```ts
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest.js";
import { runPortfolioBacktest, type SymbolInput } from "../src/portfolio-backtest.js";
import type { Candle, Params } from "../src/types.js";

function c(high: number, low: number, close: number, volume = 100, openTime = 0): Candle {
  return { openTime, open: close, high, low, close, volume };
}

const P: Params = {
  entryPeriod: 3,
  exitPeriod: 100,
  atrPeriod: 2,
  stopMult: 2,
  emaPeriod: 3,
  riskPct: 2,
  entryBufferAtr: 0,
  partialTp: null,
  timeStop: null,
  filters: {
    adx: { on: false, period: 14, min: 20 },
    volume: { on: false, period: 20, mult: 1.5 },
    vwap: { on: false, bars: 30 },
    funding: { on: false, maxAbs: 0.001 },
    oi: { on: false, minChangePct: 0 },
  },
};

function trendCandles(startOpenTime: number): Candle[] {
  const candles: Candle[] = [];
  let t = startOpenTime;
  for (let i = 0; i < 6; i++) candles.push(c(10, 9, 9.5, 100, t++));
  for (let i = 0; i < 15; i++) candles.push(c(11 + i, 10 + i, 10.8 + i, 100, t++));
  for (let i = 0; i < 8; i++) candles.push(c(25 - 2 * i, 23 - 2 * i, 23.5 - 2 * i, 100, t++));
  return candles;
}

describe("runPortfolioBacktest — single symbol reduces to runBacktest", () => {
  it("matches runBacktest trades and endEquity when gate is disabled", () => {
    const candles = trendCandles(0);
    const solo = runBacktest(candles, P, 1000);
    const portfolio = runPortfolioBacktest(
      [{ symbol: "X", candles, params: P }],
      undefined,
      1000,
      undefined,
      false,
    );
    expect(portfolio.trades.length).toBe(solo.trades.length);
    for (let i = 0; i < solo.trades.length; i++) {
      expect(portfolio.trades[i].rMultiple).toBeCloseTo(solo.trades[i].rMultiple, 6);
      expect(portfolio.trades[i].exitReason).toBe(solo.trades[i].exitReason);
    }
    expect(portfolio.stats.endEquity).toBeCloseTo(solo.stats.endEquity, 6);
  });

  it("a stop-close bar does not double as a fresh entry bar (matches runBacktest)", () => {
    // base3 flat -> breakout long @12 -> next bar stop-hits AND would satisfy a fresh
    // short breakout on the same bar if re-evaluated. runBacktest's single-loop
    // `continue` never re-checks entries on a bar that just closed a position —
    // the portfolio engine's two-pass (exits then entries) design must replicate
    // that via a same-timestamp "just closed" guard.
    const candles = [
      c(9.5, 8.5, 9, 100, 0),
      c(9.5, 8.5, 9, 100, 1),
      c(9.5, 8.5, 9, 100, 2),
      c(12, 9, 12, 100, 3), // breakout entry @12, ATR=2, stop=8
      c(8, 5, 6, 100, 4), // low 5 <= stop 8 -> stop hit; close 6 would also break short
    ];
    const solo = runBacktest(candles, P, 1000);
    const portfolio = runPortfolioBacktest(
      [{ symbol: "X", candles, params: P }],
      undefined,
      1000,
      undefined,
      false,
    );
    expect(solo.trades).toHaveLength(1);
    expect(portfolio.trades).toHaveLength(1);
    expect(portfolio.trades[0].rMultiple).toBeCloseTo(solo.trades[0].rMultiple, 6);
  });
});

describe("runPortfolioBacktest — shared equity compounds sequentially", () => {
  it("combined endEquity is the product of each trade's pnlPct, not their sum", () => {
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: trendCandles(0), params: P },
      { symbol: "B", candles: trendCandles(100), params: P },
    ];
    const result = runPortfolioBacktest(inputs, undefined, 1000, undefined, false);
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0].symbol).toBe("A");
    expect(result.trades[1].symbol).toBe("B");
    expect(result.trades[0].pnlPct).toBeGreaterThan(0);
    expect(result.trades[1].pnlPct).toBeGreaterThan(0);
    const expected = 1000 * (1 + result.trades[0].pnlPct) * (1 + result.trades[1].pnlPct);
    expect(result.stats.endEquity).toBeCloseTo(expected, 6);
    // proves compounding, not naive addition on the original base
    const naiveSum = 1000 * (1 + result.trades[0].pnlPct + result.trades[1].pnlPct);
    expect(result.stats.endEquity).not.toBeCloseTo(naiveSum, 2);
  });
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/core test`
Expected: FAIL — `Cannot find module '../src/portfolio-backtest.js'` (파일 없음)

- [ ] **Step 3: 엔진 구현**

`packages/core/src/portfolio-backtest.ts` 신규 생성:

```ts
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
      if (i === undefined || st.side === null) continue;
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
      if (i === undefined || st.side !== null || st.lastCloseTime === t) continue;
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
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/core test`
Expected: PASS — all 3 tests in `portfolio-backtest.test.ts` green, and all pre-existing tests still green.

- [ ] **Step 5: 커밋**

```bash
git add packages/core/src/portfolio-backtest.ts packages/core/test/portfolio-backtest.test.ts
git commit -m "feat(core): add shared-equity portfolio backtest engine"
```

---

### Task 2: 포트폴리오 게이트 적용 테스트 (오픈리스크캡·일/월 손실 스로틀)

**Files:**
- Modify: `packages/core/test/portfolio-backtest.test.ts`

**Interfaces:**
- Consumes: Task 1의 `runPortfolioBacktest`, `SymbolInput`(변경 없음), `DEFAULT_PORTFOLIO_GATE`(`../src/portfolio.js`)
- Produces: (없음 — 테스트 전용 태스크, 엔진 코드 변경 없음)

- [ ] **Step 1: 오픈리스크캡 테스트 추가**

`packages/core/test/portfolio-backtest.test.ts` 상단 import에 `DEFAULT_PORTFOLIO_GATE` 추가:

```ts
import { DEFAULT_PORTFOLIO_GATE } from "../src/portfolio.js";
```

파일 끝에 추가:

```ts
describe("runPortfolioBacktest — portfolio gate: open risk cap", () => {
  it("demotes (skips) a second symbol's entry while risk cap is already exceeded", () => {
    // A opens and stays open (exitPeriod huge, stop untouched) -> contributes
    // exactly riskPct% (2%) of open risk by construction of fixed-fractional sizing.
    const candlesA = [
      c(9.5, 8.5, 9, 100, 0),
      c(9.5, 8.5, 9, 100, 1),
      c(9.5, 8.5, 9, 100, 2),
      c(12, 9, 12, 100, 5), // breakout entry @12, stays open
    ];
    const candlesB = [
      c(9.5, 8.5, 9, 100, 3),
      c(9.5, 8.5, 9, 100, 4),
      c(9.5, 8.5, 9, 100, 5),
      c(12, 9, 12, 100, 6), // breakout while A is open
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: candlesA, params: P },
      { symbol: "B", candles: candlesB, params: P },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 1 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "A")).toHaveLength(1);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(0);
    expect(gated.gateStats.demotedCount).toBe(1);

    const ungated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, false);
    expect(ungated.trades.filter((t) => t.symbol === "B")).toHaveLength(1);
    expect(ungated.gateStats.demotedCount).toBe(0);
  });
});

describe("runPortfolioBacktest — portfolio gate: daily loss throttle", () => {
  const H = 3_600_000;
  const BASE = Date.UTC(2024, 0, 1, 0, 0, 0);

  function lossFixture(): Candle[] {
    return [
      c(9.5, 8.5, 9, 100, BASE + 0 * H),
      c(9.5, 8.5, 9, 100, BASE + 1 * H),
      c(9.5, 8.5, 9, 100, BASE + 2 * H),
      c(12, 9, 12, 100, BASE + 3 * H), // breakout entry @12, ATR=2, stop=8
      c(8, 5, 6, 100, BASE + 4 * H), // stop hit -> ~-2% realized same day
    ];
  }

  it("demotes a same-day entry once the daily loss throttle is breached", () => {
    const candlesB = [
      c(9.5, 8.5, 9, 100, BASE + 1 * H),
      c(9.5, 8.5, 9, 100, BASE + 2 * H),
      c(9.5, 8.5, 9, 100, BASE + 3 * H),
      c(12, 9, 12, 100, BASE + 4 * H), // same bar A's loss closes on
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P },
      { symbol: "B", candles: candlesB, params: P },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 1, monthlyLossPct: 100 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(0);
    expect(gated.gateStats.demotedCount).toBe(1);
  });

  it("resets the daily bucket on the next UTC day", () => {
    const candlesB = [
      c(9.5, 8.5, 9, 100, BASE + 27 * H),
      c(9.5, 8.5, 9, 100, BASE + 28 * H),
      c(9.5, 8.5, 9, 100, BASE + 29 * H),
      c(12, 9, 12, 100, BASE + 30 * H), // next day (30h > 24h)
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P },
      { symbol: "B", candles: candlesB, params: P },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 1, monthlyLossPct: 100 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(1);
    expect(gated.gateStats.demotedCount).toBe(0);
  });
});

describe("runPortfolioBacktest — portfolio gate: monthly loss throttle", () => {
  const H = 3_600_000;
  const BASE = Date.UTC(2024, 0, 15, 0, 0, 0);

  function lossFixture(): Candle[] {
    return [
      c(9.5, 8.5, 9, 100, BASE + 0 * H),
      c(9.5, 8.5, 9, 100, BASE + 1 * H),
      c(9.5, 8.5, 9, 100, BASE + 2 * H),
      c(12, 9, 12, 100, BASE + 3 * H),
      c(8, 5, 6, 100, BASE + 4 * H), // stop hit Jan 15 -> ~-2% realized this month
    ];
  }

  it("demotes a later-same-month entry once the monthly loss throttle is breached", () => {
    const candlesB = [
      c(9.5, 8.5, 9, 100, BASE + 5 * H),
      c(9.5, 8.5, 9, 100, BASE + 6 * H),
      c(9.5, 8.5, 9, 100, BASE + 7 * H),
      c(12, 9, 12, 100, BASE + 8 * H), // still Jan 15
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P },
      { symbol: "B", candles: candlesB, params: P },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 100, monthlyLossPct: 1 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(0);
    expect(gated.gateStats.demotedCount).toBe(1);
  });

  it("resets the monthly bucket in the next calendar month", () => {
    const febBase = Date.UTC(2024, 1, 1, 0, 0, 0);
    const candlesB = [
      c(9.5, 8.5, 9, 100, febBase + 0 * H),
      c(9.5, 8.5, 9, 100, febBase + 1 * H),
      c(9.5, 8.5, 9, 100, febBase + 2 * H),
      c(12, 9, 12, 100, febBase + 3 * H), // February
    ];
    const inputs: SymbolInput[] = [
      { symbol: "A", candles: lossFixture(), params: P },
      { symbol: "B", candles: candlesB, params: P },
    ];
    const gateCfg = { ...DEFAULT_PORTFOLIO_GATE, maxOpenRiskPct: 100, dailyLossPct: 100, monthlyLossPct: 1 };

    const gated = runPortfolioBacktest(inputs, gateCfg, 1000, undefined, true);
    expect(gated.trades.filter((t) => t.symbol === "B")).toHaveLength(1);
    expect(gated.gateStats.demotedCount).toBe(0);
  });
});
```

Note: `evaluatePortfolioGate`의 월손실 스로틀 분기는 `halveRisk=true`와 동시에 항상 `reasons`도 채워 `demote=true`가 된다(`packages/core/src/portfolio.ts` 참고). 이번 설계는 "demote=true → 진입 스킵"을 택했으므로, halveRisk가 true인 상황은 항상 데모트로 먼저 걸러져 실제 사이징에 도달하지 못한다 — 즉 halveRisk 절반사이징 경로는 현재 `evaluatePortfolioGate` 구현상 도달 불가능한 방어 코드다. 라이브 엔진(알림 전용, 차단 없음)에서는 반대로 halveRisk가 실질적 의미를 갖는다. 그래서 이 태스크는 halveRisk 사이징 자체가 아니라 월손실 스로틀이 데모트로 이어지는지만 검증한다.

- [ ] **Step 2: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/core test`
Expected: PASS — 5 new tests green (openRiskCap ×1, dailyLoss ×2, monthlyLoss ×2), plus all Task 1 tests still green.

- [ ] **Step 3: 커밋**

```bash
git add packages/core/test/portfolio-backtest.test.ts
git commit -m "test(core): cover portfolio gate wiring in portfolio backtest"
```

---

### Task 3: `packages/core` export 추가

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1의 `portfolio-backtest.ts` 모듈
- Produces: `@turtle/core`에서 `runPortfolioBacktest`, `SymbolInput`, `PortfolioTrade`, `PortfolioBacktestResult` re-export

- [ ] **Step 1: export 추가**

`packages/core/src/index.ts` 수정 (전체 내용):

```ts
export * from "./types.js";
export * from "./indicators.js";
export * from "./filters.js";
export * from "./sizing.js";
export * from "./signals.js";
export * from "./backtest.js";
export * from "./features.js";
export * from "./portfolio.js";
export * from "./portfolio-backtest.js";
export * from "./volatility.js";
```

- [ ] **Step 2: 전체 테스트 스위트로 회귀 확인**

Run: `pnpm --filter @turtle/core test`
Expected: PASS — 모든 기존 테스트(`indicators`, `features`, `portfolio`, `volatility`, `signals`, `filters`, `portfolio-backtest`) 그대로 green. export 충돌(중복 이름) 없으면 통과.

- [ ] **Step 3: 커밋**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export portfolio backtest engine from package index"
```

---

### Task 4: CLI 스크립트 `backtest:portfolio`

**Files:**
- Create: `scripts/backtest-portfolio.ts`
- Modify: `package.json:9` (스크립트 등록, `"backtest:crossval"` 라인 다음)
- Modify: `CLAUDE.md` (명령어 표 + 로드맵 섹션)

**Interfaces:**
- Consumes: `runPortfolioBacktest`, `SymbolInput`, `DEFAULT_PORTFOLIO_GATE`, `DEFAULT_PARAMS`, `runBacktest`, `DEFAULT_COSTS`, `type Candle`, `type Params`, `type Timeframe`(`../packages/core/src/index.js`), `openDb`, `Repo`(`../packages/db/src/index.js`)
- Produces: (없음 — 최상위 CLI 엔트리포인트)

- [ ] **Step 1: CLI 스크립트 작성**

`scripts/backtest-portfolio.ts` 신규 생성:

```ts
/**
 * Portfolio backtest CLI — shared-equity multi-symbol simulation with the
 * live evaluatePortfolioGate applied (entries demoted -> skipped when the
 * gate would flag them). Compares gate off vs on, plus a naive
 * independent-symbol sum for reference.
 * Usage: pnpm backtest:portfolio [interval=4h] [start=2023-01-01] [end] [--use-saved-params]
 */
import path from "node:path";
import {
  DEFAULT_COSTS,
  DEFAULT_PARAMS,
  DEFAULT_PORTFOLIO_GATE,
  runBacktest,
  runPortfolioBacktest,
  type Candle,
  type Params,
  type SymbolInput,
  type Timeframe,
} from "../packages/core/src/index.js";
import { openDb, Repo } from "../packages/db/src/index.js";

const BASE = "https://fapi.binance.com";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];

async function fetchKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    const last = Number(rows[rows.length - 1][0]);
    if (last <= cursor) break;
    cursor = last + 1;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

function defaultAdoptedParams(): Params {
  const p = structuredClone(DEFAULT_PARAMS);
  p.filters.adx.on = false;
  p.filters.volume.on = false;
  p.filters.vwap.on = false;
  p.filters.funding.on = false;
  p.filters.oi.on = false;
  return p;
}

function loadSavedParams(symbol: string, timeframe: Timeframe): Params {
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "turtle.db");
  const repo = new Repo(openDb(dbPath));
  const p = repo.getParams(symbol, timeframe);
  p.filters.funding.on = false;
  p.filters.oi.on = false;
  return p;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const useSavedParams = rawArgs.includes("--use-saved-params");
  const [interval = "4h", startStr = "2023-01-01", endStr] = rawArgs.filter(
    (a) => !a.startsWith("--"),
  );
  if (interval !== "4h" && interval !== "1d") {
    throw new Error(`interval must be 4h or 1d, got ${interval}`);
  }
  const start = Date.parse(startStr + "T00:00:00Z");
  const end = endStr ? Date.parse(endStr + "T00:00:00Z") : Date.now();
  if (Number.isNaN(start)) throw new Error(`bad start date: ${startStr}`);

  console.log(`포트폴리오 백테스트: ${SYMBOLS.join(", ")} (${interval}, ${startStr}~${endStr ?? "현재"})\n`);

  const inputs: SymbolInput[] = [];
  for (const symbol of SYMBOLS) {
    console.log(`${symbol} 캔들 로딩...`);
    const candles = await fetchKlines(symbol, interval, start, end);
    if (candles.length < DEFAULT_PARAMS.emaPeriod + 50) {
      console.warn(`⚠ ${symbol} 캔들 ${candles.length}개 — 부족, 건너뜀`);
      continue;
    }
    const params = useSavedParams ? loadSavedParams(symbol, interval as Timeframe) : defaultAdoptedParams();
    inputs.push({ symbol, candles, params });
  }
  console.log(`${inputs.length}개 심볼 로드 완료.\n`);

  const fmtPf = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "inf");
  const START_EQUITY = 10_000_000;

  const off = runPortfolioBacktest(inputs, DEFAULT_PORTFOLIO_GATE, START_EQUITY, DEFAULT_COSTS, false);
  const on = runPortfolioBacktest(inputs, DEFAULT_PORTFOLIO_GATE, START_EQUITY, DEFAULT_COSTS, true);

  console.table([
    {
      구성: "게이트 off (공유equity만)",
      거래수: off.stats.n,
      "승률%": (off.stats.winRate * 100).toFixed(1),
      PF: fmtPf(off.stats.profitFactor),
      "MDD%": (off.stats.mdd * 100).toFixed(1),
      최종자산: Math.round(off.stats.endEquity).toLocaleString(),
      강등: "-",
    },
    {
      구성: "게이트 on (실전 재현)",
      거래수: on.stats.n,
      "승률%": (on.stats.winRate * 100).toFixed(1),
      PF: fmtPf(on.stats.profitFactor),
      "MDD%": (on.stats.mdd * 100).toFixed(1),
      최종자산: Math.round(on.stats.endEquity).toLocaleString(),
      강등: `${on.gateStats.demotedCount}회`,
    },
  ]);

  const independentReturns = inputs.map((inp) => {
    const solo = runBacktest(inp.candles, inp.params, START_EQUITY, DEFAULT_COSTS);
    return solo.stats.endEquity / START_EQUITY - 1;
  });
  const avgReturn = independentReturns.reduce((s, r) => s + r, 0) / (independentReturns.length || 1);
  console.log(
    `\n참고: 심볼별 독립 실행 평균 수익률 ${(avgReturn * 100).toFixed(1)}% ` +
      `(공유equity 복리효과 없이 단순 평균 — 위 포트폴리오 결과와 직접 비교 불가, 스케일 참고용).`,
  );
  console.log("주: 수수료+슬리피지 반영, funding/OI 필터는 백테스트에서 강제 off.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: package.json에 스크립트 등록**

`package.json:9`(`"backtest:crossval": "tsx scripts/crossval.ts"` 라인) 다음에 추가:

```json
    "backtest:crossval": "tsx scripts/crossval.ts",
    "backtest:portfolio": "tsx scripts/backtest-portfolio.ts"
```

- [ ] **Step 3: 짧은 기간으로 스모크 실행**

Run: `pnpm backtest:portfolio 4h 2024-01-01 2024-03-01`
Expected: 4개 심볼 캔들 로딩 로그 → 게이트 off/on 비교 테이블 2행 출력 → 참고 수익률 라인. 에러 없이 종료(exit code 0). 네트워크 실패 시 에러 메시지 확인 후 재시도.

- [ ] **Step 4: CLAUDE.md 갱신**

`CLAUDE.md`의 명령어 코드블록에서 `pnpm backtest:crossval` 라인 다음에 추가:

```
pnpm backtest:portfolio 4h 2023-01-01               # 4심볼(BTC/ETH/SOL/BNB) 공유equity 포트폴리오 백테스트, 게이트 off/on 비교
```

`CLAUDE.md`의 "## PF 개선 로드맵" 섹션에서 항목 1 앞에 완료 표시 추가:
`1. **포트폴리오 분산 백테스트**` → `1. ~~**포트폴리오 분산 백테스트**~~ (완료 2026-07-21, `scripts/backtest-portfolio.ts`)`

- [ ] **Step 5: 커밋**

```bash
git add scripts/backtest-portfolio.ts package.json CLAUDE.md
git commit -m "feat: add portfolio backtest CLI comparing gate off/on"
```

---

## Self-Review Notes

- **Spec coverage:** 엔진(Task1)·게이트 4종 전부(Task2, 방향편중은 진입 비영향이라 코드상 gateState에 포함되지만 별도 테스트 불필요 — evaluatePortfolioGate 자체 유닛테스트가 이미 커버)·index export(Task3)·CLI 게이트off/on/단순비교(Task4) 모두 태스크 매핑됨.
- **설계 대비 변경점:** spec의 "halveRisk 사이징 검증" 테스트는 `evaluatePortfolioGate` 실제 동작(월손실 시 demote+halveRisk 동시 발생)상 데모트-스킵 모델에서 도달 불가능한 경로로 확인되어, Task2에서 월손실 데모트 검증으로 대체(Task2 Step1 note 참고). 사이징 코드 자체(halveRisk 분기)는 라이브 엔진 시맨틱과 미래 호환을 위해 엔진에 그대로 유지.
- **타입 일관성:** `SymbolInput`/`PortfolioTrade`/`PortfolioBacktestResult` 필드명이 Task1~4 전체에서 동일하게 사용됨(`symbol`, `trades`, `stats`, `gateStats.demotedCount/halvedCount`).
