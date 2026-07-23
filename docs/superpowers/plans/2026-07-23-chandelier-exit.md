# 샤데리어(ATR) 트레일링 청산 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 옵트인 구조 파라미터 `chandelier`(기본 off)를 추가해, on일 때 기존 `stopMult` 초기스톱 + `exitPeriod` 돈치안 채널청산/트레일링 전체를 "진입 이후 누적 최고/최저가 ∓ ATR×배수" 방식으로 대체한다.

**Architecture:** `Params.chandelier: ChandelierConfig | null`(기본 null). on이면 `runBacktest`(백테스트, 상태 보유 루프)와 `judgeClose`(실시간, 매 호출 재계산)가 각각 동일한 공식으로 초기스톱·트레일링을 계산하되, 초기 이탈은 기존 자간(intrabar) 스톱체크를 그대로 재사용(exitReason="stop"). 실시간 쪽은 "진입 이후" 구간을 알아야 해서 `PosCtx.entryTime` 필드를 새로 추가하고 `runner.ts`가 그 값을 넘긴다.

**Tech Stack:** TypeScript(ESM), vitest, tsx, pnpm workspace

## Global Constraints

- ESM: 소스는 `.ts`, 임포트는 `.js` 확장자
- TDD: 실패하는 테스트 먼저 작성 후 구현
- 핵심 불변식: 지표 계산(`ema`/`atr`/`donchian`)은 `packages/core`의 기존 함수만 재사용, 재구현 금지
- 초기 스톱 = 진입봉의 고가(롱)/저가(숏) ∓ `atrMult`×ATR — 진입가(종가) 기준이 아님(실제 샤데리어 정의)
- `initRisk = |entryPrice - 초기 스톱|` — 부분익절/R멀티플 계산은 이 값을 그대로 사용, 로직 변경 없음
- 트레일링은 "진입 이후 누적 최고/최저가" 기준, 유리한 방향으로만 래칫(절대 안 풀림)
- 이탈 판정은 자간(intrabar) — 기존 손절 체크(`low<=stop`/`high>=stop`) 그대로 재사용, `exitReason="stop"`
- `DEFAULT_PARAMS.chandelier = null` — 기본 off
- 기존 함수 시그니처 변경은 옵션 필드 추가만(하위호환) — `sweep.ts`/`crossval.ts`/`portfolio-backtest.ts` 등 기존 호출부 수정 불필요
- 커밋: Conventional Commits, 각 태스크 끝에 커밋

---

### Task 1: `Params.chandelier` 타입 추가 + 컴파일 유지

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/test/signals.test.ts` (컴파일 유지용 — `P` 픽스처에 필드 추가만)
- Modify: `packages/core/test/portfolio-backtest.test.ts` (컴파일 유지용 — `P` 픽스처에 필드 추가만)

**Interfaces:**
- Consumes: (없음 — 순수 타입 추가)
- Produces: `ChandelierConfig { atrMult: number }`, `Params.chandelier: ChandelierConfig | null`, `PosCtx.entryTime?: number`

- [ ] **Step 1: `types.ts` 수정**

`packages/core/src/types.ts`에서 `TimeStop` 인터페이스 다음에 추가:

```ts
export interface ChandelierConfig {
  atrMult: number; // 기본 3.0 (클래식 샤데리어 관례값)
}
```

`Params` 인터페이스에 필드 추가(`timeStop` 다음):

```ts
export interface Params {
  entryPeriod: number;
  exitPeriod: number;
  atrPeriod: number;
  stopMult: number;
  emaPeriod: number;
  riskPct: number;
  entryBufferAtr: number;
  partialTp: PartialTp | null;
  timeStop: TimeStop | null;
  /** ATR trailing stop off entry-high/low; null = off (classic donchian channel exit) */
  chandelier: ChandelierConfig | null;
  filters: FilterConfig;
}
```

`DEFAULT_PARAMS`에 필드 추가(`timeStop: null,` 다음):

```ts
  timeStop: null, // off by default; adopt only if backtest gate passes
  chandelier: null, // off by default; adopt only if backtest gate passes
```

`PosCtx` 인터페이스 수정:

```ts
export interface PosCtx {
  side: Side | null;
  entryPrice?: number;
  stop?: number;
  entryTime?: number; // needed for chandelier's "since entry" high/low scan
}
```

- [ ] **Step 2: 컴파일 유지 — 기존 `Params` 리터럴에 필드 추가**

`packages/core/test/signals.test.ts` 상단 `P` 상수(`timeStop: null,` 다음)에 추가:

```ts
  timeStop: null,
  chandelier: null,
```

`packages/core/test/portfolio-backtest.test.ts` 상단 `P` 상수도 동일하게:

```ts
  timeStop: null,
  chandelier: null,
```

- [ ] **Step 3: 전체 테스트로 회귀 확인**

Run: `pnpm test`
Expected: PASS — 전체 워크스페이스(core/db/engine) green. 새 필드 추가만이라 동작 변화 없음.

- [ ] **Step 4: 커밋**

```bash
git add packages/core/src/types.ts packages/core/test/signals.test.ts packages/core/test/portfolio-backtest.test.ts
git commit -m "feat(core): add chandelier exit config type"
```

---

### Task 2: `runBacktest`에 샤데리어 연동

**Files:**
- Modify: `packages/core/src/backtest.ts`
- Modify: `packages/core/test/signals.test.ts` (`describe("runBacktest", ...)` 블록에 테스트 추가)

**Interfaces:**
- Consumes: Task 1의 `Params.chandelier`
- Produces: (없음 — `runBacktest` 시그니처 불변, 내부 동작만 확장)

- [ ] **Step 1: 실패하는 테스트부터 작성**

`packages/core/test/signals.test.ts` 상단 import에 `atr` 추가:

```ts
import { atr } from "../src/indicators.js";
```

기존 `describe("runBacktest", () => { ... })` 블록 내부, 마지막 테스트(`"volume filter reduces..."`) 다음에 추가:

```ts
  it("chandelier initial stop uses the breakout bar's own high, not close", () => {
    const candles = [
      c(11, 9, 10),
      c(12, 10, 11),
      c(13, 11, 12),
      c(25, 12, 20), // breakout bar: high 25 (wick), close 20
      c(13, 1, 5), // collapses well below any plausible chandelier stop
    ];
    const pChand: Params = { ...P, exitPeriod: 100, chandelier: { atrMult: 2 } };
    const atrArr = atr(candles, pChand.atrPeriod);
    const atrAtEntry = atrArr[3] as number;
    const expectedStop = 25 - 2 * atrAtEntry; // from the bar's high(25), not close(20)

    const result = runBacktest(candles, pChand, 1000);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("stop");
    expect(result.trades[0].exitPrice).toBeCloseTo(expectedStop, 6);
  });

  it("chandelier stop only ratchets up, tracking the running high since entry each bar", () => {
    const candles = [
      c(9.5, 8.5, 9),
      c(9.5, 8.5, 9),
      c(9.5, 8.5, 9),
      c(15, 9, 12), // entry (breakout)
      c(20, 14, 19), // new high 20
      c(24, 18, 23), // new high 24
      c(22, 19, 20), // pulls back, no new high -- running high stays 24
      c(21, 3, 10), // collapses -- must hit the ratcheted stop, not a stale lower one
    ];
    const pChand: Params = { ...P, exitPeriod: 100, chandelier: { atrMult: 2 } };
    const atrArr = atr(candles, pChand.atrPeriod);

    // Ground truth via independent replay of the same algorithm against the
    // trusted atr() array -- avoids hand-deriving float values by hand.
    let highest = candles[3].high;
    let expectedStop = highest - 2 * (atrArr[3] as number);
    for (let i = 4; i <= 6; i++) {
      highest = Math.max(highest, candles[i].high);
      const candidate = highest - 2 * (atrArr[i] as number);
      if (candidate > expectedStop) expectedStop = candidate;
    }

    const result = runBacktest(candles, pChand, 1000);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("stop");
    expect(result.trades[0].exitPrice).toBeCloseTo(expectedStop, 6);
  });
```

Note on the second test: if it fails because the trade actually exits one bar earlier or later than
index 7, do NOT force the assertion to pass — that means the replay loop's bar range (`i <= 6`)
doesn't match where `runBacktest` actually triggers the stop. The invariant that must hold is:
the expected-stop replay must cover exactly the bars from entry+1 through the bar immediately
BEFORE whichever bar the position actually closes on (since a bar's own high/low only feeds into
the stop that bar's own trailing-update step computes, which is checked starting the NEXT bar,
not the same one). Adjust the loop's upper bound to match, re-derive, and only then decide if
there's a real implementation bug.

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: FAIL — `runBacktest`가 아직 `params.chandelier`를 모름(기존 돈치안 채널 로직만 실행되어
`exitReason`이 `"channel"`이 되거나 `exitPrice`가 다른 값으로 나옴).

- [ ] **Step 3: `backtest.ts` 구현**

`packages/core/src/backtest.ts` 전체를 아래로 교체:

```ts
import { atr, donchian, ema } from "./indicators.js";
import { allPassed, evaluateFilters } from "./filters.js";
import type { Candle, Params, Side } from "./types.js";

export interface Trade {
  side: Side;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "stop" | "channel" | "time";
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

/** Trading costs, each as a per-side percentage (0.05 = 0.05%). */
export interface BacktestCosts {
  takerPct: number; // taker fee per fill
  slippagePct: number; // adverse fill slippage per fill
}

/** Realistic Binance futures taker costs — use in CLI/scripts, not unit tests. */
export const DEFAULT_COSTS: BacktestCosts = { takerPct: 0.05, slippagePct: 0.05 };

/** Zero costs — default for the pure function so unit tests stay deterministic. */
export const NO_COSTS: BacktestCosts = { takerPct: 0, slippagePct: 0 };

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
  costs: BacktestCosts = NO_COSTS,
  higherTfCandles: Candle[] = [],
): BacktestResult {
  const slip = costs.slippagePct / 100;
  const taker = costs.takerPct / 100;
  const entryBands = donchian(candles, params.entryPeriod);
  const exitBands = donchian(candles, params.exitPeriod);
  const emaArr = ema(
    candles.map((c) => c.close),
    params.emaPeriod,
  );
  const atrArr = atr(candles, params.atrPeriod);
  const higherEmaArr = params.filters.regime.on
    ? ema(higherTfCandles.map((c) => c.close), params.filters.regime.emaPeriod)
    : [];
  let regimePtr = -1; // index into higherTfCandles: last CLOSED bar as of the current 4h bar
  const ONE_DAY_MS = 86_400_000;

  const trades: Trade[] = [];
  let equity = startEquity;
  let peak = startEquity;
  let mdd = 0;

  let side: Side | null = null;
  let entryPrice = 0; // nominal close at entry (used for stop/target geometry)
  let effEntry = 0; // slippage-adjusted entry fill
  let entryTime = 0;
  let stop = 0;
  let initRisk = 0; // price distance at entry
  let partialDone = false;
  let realizedR = 0; // R already banked by partial take-profit (net of slippage)
  let feeR = 0; // accumulated fee cost expressed in R (entry + partial fills)
  let openFraction = 1; // fraction of the position still open
  let barsInTrade = 0; // bars elapsed since entry
  let reached1R = false; // whether price ever reached +1R
  let highestSinceEntry = 0; // chandelier: running high since entry (long)
  let lowestSinceEntry = 0; // chandelier: running low since entry (short)

  const closeTrade = (
    exitTime: number,
    exitPrice: number,
    exitReason: "stop" | "channel" | "time",
  ) => {
    const dir = side === "long" ? 1 : -1;
    const effExit = exitPrice * (1 - slip * dir); // adverse slippage on exit fill
    const remainingR = initRisk > 0 ? ((effExit - effEntry) * dir / initRisk) * openFraction : 0;
    const finalFeeR = initRisk > 0 ? (effExit * taker) / initRisk * openFraction : 0;
    const r = realizedR + remainingR - feeR - finalFeeR;
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
    const atrV = atrArr[i];

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
          const dir = side === "long" ? 1 : -1;
          const effFill = target * (1 - slip * dir); // adverse slippage on the partial exit
          realizedR += ((effFill - effEntry) * dir / initRisk) * ptp.fraction;
          feeR += (effFill * taker) / initRisk * ptp.fraction;
          openFraction -= ptp.fraction;
          partialDone = true;
          if (ptp.moveStopToBreakeven) {
            // ratchet stop to breakeven, never loosen an already-favorable trail
            stop = side === "long" ? Math.max(stop, entryPrice) : Math.min(stop, entryPrice);
          }
        }
      }
      // 2) trailing: chandelier (ATR off the running high/low since entry)
      // replaces the donchian channel exit+ratchet entirely when enabled --
      // the intrabar stop check in (1) is the only exit trigger either way.
      if (params.chandelier) {
        const mult = params.chandelier.atrMult;
        if (side === "long") {
          highestSinceEntry = Math.max(highestSinceEntry, c.high);
          if (atrV !== null) {
            const candidate = highestSinceEntry - mult * atrV;
            if (candidate > stop) stop = candidate;
          }
        } else {
          lowestSinceEntry = Math.min(lowestSinceEntry, c.low);
          if (atrV !== null) {
            const candidate = lowestSinceEntry + mult * atrV;
            if (candidate < stop) stop = candidate;
          }
        }
      } else {
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
      }
      // 4) time stop: exit if +1R never reached within N bars
      barsInTrade++;
      const oneRTarget = side === "long" ? entryPrice + initRisk : entryPrice - initRisk;
      if (side === "long" ? c.high >= oneRTarget : c.low <= oneRTarget) reached1R = true;
      if (params.timeStop && !reached1R && barsInTrade >= params.timeStop.bars) {
        closeTrade(c.openTime, c.close, "time");
        continue;
      }
      continue;
    }

    // Flat: entries
    const eb = entryBands[i];
    const emaV = emaArr[i];
    if (eb === null || emaV === null || atrV === null) continue;

    if (params.filters.regime.on) {
      while (
        regimePtr + 1 < higherTfCandles.length &&
        higherTfCandles[regimePtr + 1].openTime + ONE_DAY_MS <= c.openTime
      ) {
        regimePtr++;
      }
    }
    const regimeDir: Side | null =
      params.filters.regime.on && regimePtr >= 0 && higherEmaArr[regimePtr] !== null
        ? higherTfCandles[regimePtr].close >= (higherEmaArr[regimePtr] as number)
          ? "long"
          : "short"
        : null;

    let dir: Side | null = null;
    const buf = (params.entryBufferAtr ?? 0) * atrV;
    if (c.close > eb.upper + buf && c.close > emaV) dir = "long";
    else if (c.close < eb.lower - buf && c.close < emaV) dir = "short";
    if (dir === null) continue;

    const cfg = {
      ...params.filters,
      funding: { ...params.filters.funding, on: false },
      oi: { ...params.filters.oi, on: false }, // no historical OI series
    };
    const checks = evaluateFilters(dir, candles.slice(0, i + 1), i, null, cfg, null, regimeDir);
    if (!allPassed(checks)) continue;

    side = dir;
    entryPrice = c.close;
    entryTime = c.openTime;
    if (params.chandelier) {
      const mult = params.chandelier.atrMult;
      if (dir === "long") {
        highestSinceEntry = c.high;
        stop = highestSinceEntry - mult * atrV;
      } else {
        lowestSinceEntry = c.low;
        stop = lowestSinceEntry + mult * atrV;
      }
      initRisk = Math.abs(c.close - stop);
    } else {
      initRisk = params.stopMult * atrV;
      stop = dir === "long" ? c.close - initRisk : c.close + initRisk;
    }
    effEntry = c.close * (1 + slip * (dir === "long" ? 1 : -1)); // adverse slippage on entry fill
    feeR = initRisk > 0 ? (effEntry * taker) / initRisk : 0; // entry fee (full position)
    partialDone = false;
    realizedR = 0;
    openFraction = 1;
    barsInTrade = 0;
    reached1R = false;
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
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: PASS — 신규 2개 테스트 green, 기존 모든 테스트도 green(무변경 회귀).

- [ ] **Step 5: 전체 회귀 테스트 + 커밋**

Run: `pnpm test`
Expected: PASS.

```bash
git add packages/core/src/backtest.ts packages/core/test/signals.test.ts
git commit -m "feat(core): wire chandelier exit into runBacktest"
```

---

### Task 3: `judgeClose`에 샤데리어 연동

**Files:**
- Modify: `packages/core/src/signals.ts`
- Modify: `packages/core/test/signals.test.ts` (`judgeClose` 관련 describe 블록에 테스트 추가)

**Interfaces:**
- Consumes: Task 1의 `Params.chandelier`, `PosCtx.entryTime`
- Produces: (없음 — `judgeClose` 시그니처 불변, 내부 동작만 확장)

- [ ] **Step 1: 실패하는 테스트부터 작성**

`packages/core/test/signals.test.ts`의 `describe("judgeClose entries", ...)` 블록 안,
마지막 테스트(entry buffer 관련 것 다음 또는 아무 곳) 뒤에 새 describe 추가(파일 끝,
`describe("runBacktest", ...)` 블록 앞 또는 뒤 아무 곳이나 — 다른 describe와 독립적):

```ts
describe("judgeClose with chandelier exit", () => {
  const withChand: Params = { ...P, chandelier: { atrMult: 2 } };

  it("entry stop uses the breakout bar's own high, not close", () => {
    const candles = [
      c(11, 9, 10),
      c(12, 10, 11),
      c(13, 11, 12),
      c(25, 12, 20), // breakout bar: high 25 (wick), close 20
    ];
    const ev = judgeClose(FLAT, candles, withChand, null);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("ENTRY_LONG");
    if (ev[0].type === "ENTRY_LONG") {
      expect(ev[0].stop).toBeCloseTo(25 - 2 * ev[0].atr, 6);
      expect(ev[0].stop).not.toBeCloseTo(20 - 2 * ev[0].atr, 1); // differs from close-based calc
    }
  });

  it("trailing only considers candles at/after entryTime for the high/low scan (no look-back pollution)", () => {
    // stop set far below anything plausible so a TRAIL_UPDATE always fires
    // regardless of ATR magnitude -- this test isolates the high/low SCAN
    // (does "highest" correctly exclude the pre-entry candle?), not the ATR
    // value itself (ATR is legitimately computed over the full history,
    // untouched by the entryTime scoping -- that's correct, unrelated behavior).
    const pos = { side: "long" as const, entryPrice: 12, stop: -100, entryTime: 30 };
    const candles = [
      c(100, 90, 95, 100, 0), // huge pre-entry high -- must be ignored by the scan
      c(13, 11, 12, 100, 10),
      c(14, 12, 13, 100, 20),
      c(16, 13, 15, 100, 30), // entry bar (openTime === entryTime)
      c(18, 14, 17, 100, 40), // post-entry high 18
    ];
    const ev = judgeClose(pos, candles, withChand, null);
    const atrArr = atr(candles, withChand.atrPeriod);
    const atrAtLast = atrArr[atrArr.length - 1] as number;
    // if the pre-entry high(100) leaked into the scan, highest would be 100
    // instead of 18 (the true post-entry max), producing a wildly different
    // candidate -- comparing against the 18-based formula is what actually
    // proves exclusion, regardless of ATR's real (possibly pre-entry-influenced,
    // and that's fine) magnitude.
    const expectedCandidate = 18 - withChand.chandelier!.atrMult * atrAtLast;
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("TRAIL_UPDATE");
    if (ev[0].type === "TRAIL_UPDATE") {
      expect(ev[0].newStop).toBeCloseTo(expectedCandidate, 6);
      expect(ev[0].newStop).toBeLessThan(50); // sanity bound: rules out the polluted (100-based) formula
    }
  });

  it("skips trailing (no crash, no event) when entryTime is missing", () => {
    const pos = { side: "long" as const, entryPrice: 12, stop: 8 }; // no entryTime
    const candles = [
      c(13, 11, 12, 100, 0),
      c(14, 12, 13, 100, 1),
      c(18, 14, 17, 100, 2),
    ];
    const ev = judgeClose(pos, candles, withChand, null);
    expect(ev).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: FAIL — `judgeClose`가 아직 `params.chandelier`/`pos.entryTime`을 모름(기존 채널 로직만
실행되어 `exitBand===null`이면 빈 배열 반환하거나, entry stop이 close 기준으로 계산됨).

- [ ] **Step 3: `signals.ts` 구현**

`packages/core/src/signals.ts` 전체를 아래로 교체:

```ts
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
 * - Initial stop: entry -/+ stopMult * ATR(atrPeriod) (classic), or the
 *   breakout bar's own high/low -/+ chandelier.atrMult * ATR (chandelier).
 * - Trailing: exitPeriod opposite extreme ratchets the stop (classic), or
 *   the running high/low since entry -/+ chandelier.atrMult * ATR (chandelier).
 * - Exit: close beyond exitPeriod opposite extreme (classic only — chandelier
 *   has no close-based exit, only the intrabar stop, handled by the stop monitor).
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
        const stop = params.chandelier
          ? candles[i].high - params.chandelier.atrMult * atrV
          : close - params.stopMult * atrV;
        events.push({
          type: "ENTRY_LONG",
          price: close,
          stop,
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
        const stop = params.chandelier
          ? candles[i].low + params.chandelier.atrMult * atrV
          : close + params.stopMult * atrV;
        events.push({
          type: "ENTRY_SHORT",
          price: close,
          stop,
          atr: atrV,
          filters: checks,
        });
      } else {
        events.push({ type: "ENTRY_BLOCKED", dir: "short", price: close, filters: checks });
      }
    }
    return events;
  }

  // Holding a position: chandelier replaces the channel exit+trailing entirely.
  if (params.chandelier) {
    if (pos.entryTime === undefined || atrV === null) return events;
    const since = candles.filter((c) => c.openTime >= (pos.entryTime as number));
    if (since.length === 0) return events;
    const mult = params.chandelier.atrMult;
    if (pos.side === "long") {
      const highest = Math.max(...since.map((c) => c.high));
      const candidate = highest - mult * atrV;
      if (pos.stop !== undefined && candidate > pos.stop) {
        events.push({ type: "TRAIL_UPDATE", newStop: candidate, prevStop: pos.stop });
      }
    } else {
      const lowest = Math.min(...since.map((c) => c.low));
      const candidate = lowest + mult * atrV;
      if (pos.stop !== undefined && candidate < pos.stop) {
        events.push({ type: "TRAIL_UPDATE", newStop: candidate, prevStop: pos.stop });
      }
    }
    return events;
  }

  // Holding a position (classic): exit first, else trailing update.
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
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: PASS — 신규 3개 테스트 green, 기존 전체 테스트도 green.

- [ ] **Step 5: 전체 회귀 테스트 + 커밋**

Run: `pnpm test`
Expected: PASS.

```bash
git add packages/core/src/signals.ts packages/core/test/signals.test.ts
git commit -m "feat(core): wire chandelier exit into judgeClose"
```

---

### Task 4: 실시간 엔진 연동 (`apps/engine`)

**Files:**
- Modify: `apps/engine/src/runner.ts`
- Modify: `apps/engine/test/runner.test.ts`

**Interfaces:**
- Consumes: Task 3의 `judgeClose(..., higherTfCandles?)`(변경 없음), Task 1의 `PosCtx.entryTime`
- Produces: (없음 — 엔진 내부 배선)

- [ ] **Step 1: 실패하는 테스트부터 작성**

`apps/engine/test/runner.test.ts`의 `describe("processSymbol", ...)` 블록 내부에 추가:

```ts
  it("threads entryTime through to judgeClose so chandelier trailing scopes to post-entry candles", async () => {
    const now = Math.floor(Date.now() / H4) * H4 + 60_000;
    const lastClosed = lastClosedOpenTime("4h", now);

    const db = openDb(":memory:");
    const r = new Repo(db);
    const p = r.getParams("BTCUSDT", "4h");
    p.chandelier = { atrMult: 2 };
    r.upsertParams("BTCUSDT", "4h", p);

    const entryTime = lastClosed - 4 * H4;
    const posId = r.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 50, // deliberately far below any plausible chandelier level
    });
    db.prepare("UPDATE positions SET openedAt=? WHERE id=?").run(entryTime, posId);

    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      // pre-entry: huge high(200) that must NOT leak into the trailing scan
      candles.push({ openTime: entryTime - (30 - i) * H4, open: 100, high: 200, low: 90, close: 100, volume: 100 });
    }
    candles.push({ openTime: entryTime, open: 100, high: 110, low: 95, close: 105, volume: 100 });
    candles.push({ openTime: entryTime + H4, open: 105, high: 115, low: 100, close: 110, volume: 100 });
    candles.push({ openTime: entryTime + 2 * H4, open: 110, high: 120, low: 105, close: 115, volume: 100 });
    candles.push({ openTime: entryTime + 3 * H4, open: 115, high: 122, low: 110, close: 118, volume: 100 });
    candles.push({ openTime: lastClosed, open: 118, high: 125, low: 112, close: 120, volume: 100 });

    const telegram = { send: vi.fn(async () => true) };
    const binance = {
      fetchKlines: vi.fn(async () => candles.map((c) => ({ ...c }))),
      fetchKlinesRaw: vi.fn(async () => [] as Candle[]),
      fetchMarkPrice: vi.fn(async () => 0),
      fetchFunding: vi.fn(async () => 0.0001),
      fetchOiChangePct: vi.fn(async () => null),
    };
    const health = new Health(r, telegram);
    const deps: RunnerDeps = { repo: r, binance, telegram, health };

    await processSymbol(deps, "BTCUSDT", "4h", now);

    const updated = r.getOpenPosition("BTCUSDT", "4h");
    // trailed up from the stale 50 -> proves entryTime threaded through and a
    // TRAIL_UPDATE fired; bounded well under 200-2*ATR proves the pre-entry
    // high(200) did NOT leak into the scan (it would push this way above 125).
    expect(updated?.stop).toBeGreaterThan(50);
    expect(updated?.stop).toBeLessThan(125);
  });
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/engine test -- runner.test.ts`
Expected: FAIL — `runner.ts`가 아직 `pos.entryTime`을 안 넘겨서 `judgeClose`가 `entryTime===undefined`로
보고 트레일 업데이트를 스킵, 스톱이 50에 그대로 남음.

- [ ] **Step 3: `runner.ts`에 배선 추가**

`apps/engine/src/runner.ts`에서 `pos` 구성 라인을 찾아 수정:

```ts
    const pos: PosCtx = open
      ? { side: open.side, entryPrice: open.entryPrice, stop: open.stop }
      : { side: null };
```

다음으로 교체:

```ts
    const pos: PosCtx = open
      ? { side: open.side, entryPrice: open.entryPrice, stop: open.stop, entryTime: open.openedAt }
      : { side: null };
```

`PosCtx` 타입이 이미 `@turtle/core`에서 import되어 있으므로(기존 `import { ..., type PosCtx, ... } from "@turtle/core"`) 추가 import 불필요.

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/engine test -- runner.test.ts`
Expected: PASS.

- [ ] **Step 5: 전체 회귀 테스트 + 커밋**

Run: `pnpm test`
Expected: PASS.

```bash
git add apps/engine/src/runner.ts apps/engine/test/runner.test.ts
git commit -m "feat(engine): thread position entryTime through for chandelier trailing"
```

---

### Task 5: `scripts/backtest.ts` CLI 비교행 + 문서 갱신

**Files:**
- Modify: `scripts/backtest.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 2의 `runBacktest`(변경 없음, `chandelier` 필드가 있는 `Params`를 넘기기만 하면 됨)
- Produces: (없음 — 최상위 CLI)

- [ ] **Step 1: CLI에 샤데리어 비교행 추가**

`scripts/backtest.ts`의 `withRegime` 함수 다음에 헬퍼 추가:

```ts
function withChandelier(): Params {
  const p = withFilters({});
  p.chandelier = { atrMult: 3 };
  return p;
}
```

`combos` 배열 수정 — `전부 ON` 행 바로 앞에 추가:

```ts
  const combos: [string, Params][] = [
    ["필터 없음 (원조 터틀)", withFilters({})],
    ["ADX만", withFilters({ adx: true })],
    ["거래량만", withFilters({ volume: true })],
    ["VWAP만", withFilters({ vwap: true })],
    ...(interval !== "1d" ? ([["레짐만(1d)", withRegime()]] as [string, Params][]) : []),
    ["샤데리어(3xATR)", withChandelier()],
    ["전부 ON", withFilters({ adx: true, volume: true, vwap: true })],
  ];
```

(레짐 행과 달리 샤데리어는 추가 캔들 fetch가 필요 없으므로 `dailyCandles`/`higherTf` 관련 코드는
그대로 — `label.includes("레짐")`이 아닌 행은 이미 기존 코드에서 `higherTf = []`로 처리됨.)

- [ ] **Step 2: 짧은 기간으로 스모크 실행**

Run: `pnpm backtest BTCUSDT 4h 2024-01-01 2024-06-01`
Expected: 콤보 표에 "샤데리어(3xATR)" 행 포함 6행 출력(레짐 포함 시), 에러 없이 종료.

- [ ] **Step 3: `CLAUDE.md` 갱신**

"트레일링/청산" 줄(`- **트레일링/청산**: **15봉** 반대 채널...`) 다음에 추가:

```
- **샤데리어 트레일링** (`chandelier.atrMult`, 기본 off): on이면 초기스톱·트레일링·이탈판정 전체가 "진입 이후 누적 최고/최저가 ∓ ATR×배수"(기본 3×) 방식으로 교체됨(자간 이탈, exitReason="stop") — `exitPeriod` 채널청산은 이때 미사용. `backtest`로 검증 가능
```

"PF 개선 로드맵" 섹션 항목 3에 완료 표시:

```
3. ~~**청산 로직 개선**~~ (완료 2026-07-23) — 스윕에서 청산봉수(15 vs 20)가 진입/손절보다 PF 영향 큼. ATR 기반 트레일링(chandelier식)으로 교체 검토
```

- [ ] **Step 4: 커밋**

```bash
git add scripts/backtest.ts CLAUDE.md
git commit -m "feat: add chandelier exit comparison row to backtest CLI"
```

---

## Self-Review Notes

- **Spec coverage:** 타입(Task1) · runBacktest 연동(Task2) · judgeClose 연동(Task3) · 엔진 배선(Task4) · CLI+문서(Task5) 전부 매핑됨.
- **하위호환:** `runBacktest`/`judgeClose` 시그니처 불변(옵션 필드만 확장) — `sweep.ts`/`crossval.ts`/`portfolio-backtest.ts`/`apps/web` 등 기존 호출부 수정 불필요, `chandelier: null` 기본값으로 기존 동작 그대로.
- **범위 밖(후속 과제):** `scripts/sweep.ts`/`scripts/crossval.ts` 연동 — 포트폴리오·레짐 기능과 동일하게 보류. 포지션 페이지(`apps/web/app/positions/page.tsx`)의 손절가 자동계산 계산기는 여전히 `stopMult` 기준만 계산 — 샤데리어 심볼 사용 시 사용자가 직접 스톱값을 입력해야 함(계산기가 인지 못 함), 이번 스코프 아님.
- **타입 일관성:** `ChandelierConfig`/`chandelier`/`entryTime` 이름이 Task1~4 전체에서 동일하게 사용됨.
