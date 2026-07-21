# 레짐 필터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4h 신호가 1d 상위 타임프레임 추세(EMA 기준)와 같은 방향일 때만 통과시키는 `regime` 필터를 코어·backtest CLI·실시간 엔진 전체에 연동한다.

**Architecture:** `FilterConfig`에 `regime: { on, emaPeriod }` 필드 추가. 판정은 "직전 완결된 1d 봉 종가 vs 1d EMA" — 상위 타임프레임 캔들 배열을 호출부(judgeClose/runBacktest/엔진)가 넘겨주고, `evaluateFilters`는 이미 계산된 `regimeDir: Side | null`만 받는다(다른 필터처럼 스스로 지표를 재계산하지 않음 — 정렬 로직은 그걸 아는 호출부 책임). `judgeClose`는 매 호출 1회이므로 O(n) 헬퍼(`resolveRegimeDir`)로 간단히, `runBacktest`는 전 구간 순회라 포인터 전진 방식으로 O(n) 유지.

**Tech Stack:** TypeScript(ESM), vitest, tsx, pnpm workspace

## Global Constraints

- ESM: 소스는 `.ts`, 임포트는 `.js` 확장자
- TDD: 실패하는 테스트 먼저 작성 후 구현
- 핵심 불변식: 지표 계산은 `packages/core`의 기존 함수(`ema` 등)만 재사용, 재구현 금지
- 신규 필터는 기존 5개(adx/volume/vwap/funding/oi)와 동일한 관례: 개별 on/off, 진입에만 적용, 데이터 없으면 통과 처리
- 시간 정렬: 4h 봉 판정 시 **직전 완결된 1d 봉만** 사용 — `d.openTime + 86_400_000 <= t4h`. 진행 중/미래 1d 봉 참조 금지(look-ahead 방지)
- `DEFAULT_PARAMS.filters.regime = { on: false, emaPeriod: 200 }` — 기본 off
- 기존 함수 시그니처 변경은 전부 **옵션 파라미터 추가**(하위호환) — `sweep.ts`/`crossval.ts`/`portfolio-backtest.ts` 등 기존 호출부는 수정 불필요
- 커밋: Conventional Commits, 각 태스크 끝에 커밋

---

### Task 1: `FilterConfig`에 `regime` 필드 추가 + 판정 로직 (정렬 없이, on/off·null 처리만)

이 태스크는 `regime`을 타입 시스템에 정식 필드로 편입시키고 `evaluateFilters`가 미리 계산된
`regimeDir`을 받아 판정하는 로직까지 만든다. 아직 "어느 1d 봉을 쓸지" 정렬 로직(Task 2)은
포함하지 않는다 — `regimeDir`은 이 태스크에서는 테스트가 직접 값을 넣어준다.

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/filters.ts`
- Modify: `packages/core/test/filters.test.ts`
- Modify: `packages/db/src/repo.ts`
- Modify: `packages/db/test/repo.test.ts`
- Modify: `packages/core/test/signals.test.ts` (컴파일 유지용 — 로컬 `P` 픽스처에 필드 추가만, 새 테스트는 Task 2)
- Modify: `packages/core/test/portfolio-backtest.test.ts` (컴파일 유지용 — 로컬 `P` 픽스처에 필드 추가만)

**Interfaces:**
- Consumes: (없음 — 순수 타입/로직 추가)
- Produces: `FilterConfig.regime: { on: boolean; emaPeriod: number }`, `evaluateFilters(dir, candles, i, funding, cfg, oiChangePct?, regimeDir?: Side | null): FilterCheck[]` (7번째 파라미터 추가, 기본값 `null`), `FilterCheck["name"]`에 `"regime"` 추가

- [ ] **Step 1: 실패하는 테스트부터 작성 — `filters.test.ts`**

`packages/core/test/filters.test.ts` 수정. 상단 `OFF` 상수에 필드 추가:

```ts
const OFF: FilterConfig = {
  adx: { on: false, period: 14, min: 20 },
  volume: { on: false, period: 20, mult: 1.5 },
  vwap: { on: false, bars: 30 },
  funding: { on: false, maxAbs: 0.001 },
  oi: { on: false, minChangePct: 0 },
  regime: { on: false, emaPeriod: 200 },
};
```

`"all off -> all pass"` 테스트의 길이 기대값 5→6으로:

```ts
  it("all off -> all pass", () => {
    const candles = [c(1, 0, 1), c(1, 0, 1)];
    const checks = evaluateFilters("long", candles, 1, null, OFF);
    expect(checks).toHaveLength(6);
    expect(allPassed(checks)).toBe(true);
  });
```

파일 끝(`describe("positionSize"...)` 앞)에 새 describe 추가:

```ts
describe("regime filter", () => {
  const cfg: FilterConfig = { ...OFF, regime: { on: true, emaPeriod: 200 } };
  const candles = [c(1, 0, 1), c(1, 0, 1)];

  it("passes when regimeDir matches entry direction", () => {
    expect(allPassed(evaluateFilters("long", candles, 1, null, cfg, null, "long"))).toBe(true);
    expect(allPassed(evaluateFilters("short", candles, 1, null, cfg, null, "short"))).toBe(true);
  });

  it("blocks when regimeDir opposes entry direction", () => {
    expect(allPassed(evaluateFilters("long", candles, 1, null, cfg, null, "short"))).toBe(false);
    expect(allPassed(evaluateFilters("short", candles, 1, null, cfg, null, "long"))).toBe(false);
  });

  it("null regimeDir (no higher-tf data) passes with a note", () => {
    const checks = evaluateFilters("long", candles, 1, null, cfg, null, null);
    expect(allPassed(checks)).toBe(true);
    expect(checks.find((f) => f.name === "regime")!.detail).toContain("데이터 부족");
  });

  it("off -> passes regardless of regimeDir", () => {
    expect(allPassed(evaluateFilters("long", candles, 1, null, OFF, null, "short"))).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/core test -- filters.test.ts`
Expected: FAIL — `OFF` 리터럴에 `regime` 없어 타입 에러(`FilterConfig` 프로퍼티 누락), 그리고
새 `describe("regime filter")` 테스트들은 `evaluateFilters`가 7번째 인자를 모르므로 타입/런타임
실패.

- [ ] **Step 3: `types.ts`에 필드 추가**

`packages/core/src/types.ts` 수정. `FilterConfig` 인터페이스:

```ts
export interface FilterConfig {
  adx: { on: boolean; period: number; min: number };
  volume: { on: boolean; period: number; mult: number };
  vwap: { on: boolean; bars: number };
  funding: { on: boolean; maxAbs: number }; // maxAbs as rate, e.g. 0.001 = 0.1%
  // OI confirmation: breakout should coincide with rising open interest (new money).
  // Like funding, no long historical series via free API -> live-only, default off.
  oi: { on: boolean; minChangePct: number }; // e.g. 0 => require OI change > 0%
  // Higher-timeframe (1d) trend regime: entry direction must match the last
  // CLOSED 1d bar's close-vs-EMA(emaPeriod) direction. Backtestable (unlike
  // funding/oi) since daily klines have long free history.
  regime: { on: boolean; emaPeriod: number };
}
```

`DEFAULT_PARAMS.filters`에 추가:

```ts
  filters: {
    adx: { on: true, period: 14, min: 20 },
    volume: { on: true, period: 20, mult: 1.5 },
    vwap: { on: true, bars: 30 },
    funding: { on: true, maxAbs: 0.001 },
    oi: { on: false, minChangePct: 0 }, // off by default; not long-backtestable
    regime: { on: false, emaPeriod: 200 }, // off by default; adopt only if backtest gate passes
  },
```

`FilterCheck["name"]` 유니온에 `"regime"` 추가:

```ts
export interface FilterCheck {
  name: "adx" | "volume" | "vwap" | "funding" | "oi" | "regime";
  passed: boolean;
  value: number | null;
  detail: string;
}
```

- [ ] **Step 4: `filters.ts`에 판정 로직 추가**

`packages/core/src/filters.ts` — 함수 시그니처 수정:

```ts
export function evaluateFilters(
  dir: Side,
  candles: Candle[],
  i: number,
  funding: number | null,
  cfg: FilterConfig,
  oiChangePct: number | null = null,
  regimeDir: Side | null = null,
): FilterCheck[] {
```

`return checks;` 직전(oi 블록 다음)에 추가:

```ts
  // Higher-timeframe (1d) regime confirmation: entry direction must match the
  // last closed daily bar's trend (close vs EMA). regimeDir is precomputed by
  // the caller (judgeClose/runBacktest), which owns the alignment logic.
  if (cfg.regime.on) {
    if (regimeDir === null) {
      checks.push({ name: "regime", passed: true, value: null, detail: "1d 데이터 부족 - 통과 처리" });
    } else {
      checks.push({
        name: "regime",
        passed: regimeDir === dir,
        value: null,
        detail: `1d 레짐 ${regimeDir === "long" ? "상승" : "하락"} vs 진입 ${dir === "long" ? "롱" : "숏"}`,
      });
    }
  } else {
    checks.push({ name: "regime", passed: true, value: null, detail: "off" });
  }

  return checks;
```

- [ ] **Step 5: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/core test -- filters.test.ts`
Expected: PASS — 모든 `filters.test.ts` 테스트 green.

- [ ] **Step 6: 나머지 패키지의 `FilterConfig` 리터럴 컴파일 수정**

이 시점에서 `pnpm test`를 돌리면 `regime` 필드가 없는 기존 리터럴들이 타입 에러를 낸다.
아래 파일들을 수정:

`packages/core/test/signals.test.ts` — 상단 `P` 상수의 `filters` 객체에 추가:

```ts
const P: Params = {
  entryPeriod: 3,
  exitPeriod: 2,
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
    regime: { on: false, emaPeriod: 200 },
  },
};
```

`packages/core/test/portfolio-backtest.test.ts` — 상단 `P` 상수의 `filters` 객체에 동일하게
`regime: { on: false, emaPeriod: 200 },` 추가(마지막 필드로).

- [ ] **Step 7: `packages/db`에서 legacy row 대응 — 실패하는 테스트부터**

`packages/db/test/repo.test.ts`의 기존 `"params saved before a new filter (e.g. oi) was added..."`
테스트 바로 다음에 새 테스트 추가:

```ts
  it("params saved before regime filter was added still merge in the new default", () => {
    const r = repo();
    const old = structuredClone(DEFAULT_PARAMS) as Partial<typeof DEFAULT_PARAMS>;
    const oldFilters = old.filters as Partial<(typeof DEFAULT_PARAMS)["filters"]>;
    delete oldFilters.regime;
    r.upsertParams("SOLUSDT", "4h", old as typeof DEFAULT_PARAMS);
    const loaded = r.getParams("SOLUSDT", "4h");
    expect(loaded.filters.regime).toEqual(DEFAULT_PARAMS.filters.regime);
    expect(loaded.filters.adx).toEqual(DEFAULT_PARAMS.filters.adx);
  });
```

Run: `pnpm --filter @turtle/db test`
Expected: FAIL — `repo.ts`의 deep-merge가 아직 `regime`을 모름, `loaded.filters.regime`이
`undefined`.

- [ ] **Step 8: `repo.ts`의 deep-merge에 `regime` 추가**

`packages/db/src/repo.ts`의 `getParams` 메서드, `filters:` 블록에 한 줄 추가:

```ts
      filters: {
        adx: { ...defaults.filters.adx, ...sf.adx },
        volume: { ...defaults.filters.volume, ...sf.volume },
        vwap: { ...defaults.filters.vwap, ...sf.vwap },
        funding: { ...defaults.filters.funding, ...sf.funding },
        oi: { ...defaults.filters.oi, ...sf.oi },
        regime: { ...defaults.filters.regime, ...sf.regime },
      },
```

- [ ] **Step 9: 전체 회귀 테스트**

Run: `pnpm test`
Expected: PASS — `packages/core`, `packages/db`, `apps/engine` 전 테스트 green (신규분 포함).

- [ ] **Step 10: 커밋**

```bash
git add packages/core/src/types.ts packages/core/src/filters.ts packages/core/test/filters.test.ts packages/core/test/signals.test.ts packages/core/test/portfolio-backtest.test.ts packages/db/src/repo.ts packages/db/test/repo.test.ts
git commit -m "feat(core): add regime filter type + evaluation logic"
```

---

### Task 2: 1d→4h 정렬 헬퍼 `resolveRegimeDir` + `judgeClose` 연동

**Files:**
- Modify: `packages/core/src/signals.ts`
- Modify: `packages/core/test/signals.test.ts`

**Interfaces:**
- Consumes: Task 1의 `evaluateFilters(..., regimeDir)`, `ema`(`./indicators.js`)
- Produces: `resolveRegimeDir(higherTfCandles: Candle[] | undefined, atOpenTime: number, emaPeriod: number): Side | null`, `judgeClose(pos, candles, params, funding, oiChangePct?, higherTfCandles?: Candle[]): SignalEvent[]` (6번째 파라미터 추가)

- [ ] **Step 1: 실패하는 테스트부터 작성**

`packages/core/test/signals.test.ts`에 `resolveRegimeDir` import 추가(상단):

```ts
import { judgeClose, resolveRegimeDir } from "../src/signals.js";
```

파일 끝(마지막 `describe`, `runBacktest` 블록) 뒤에 새 describe 추가:

```ts
describe("resolveRegimeDir", () => {
  const DAY = 86_400_000;
  function d(close: number, openTime: number): Candle {
    return { openTime, open: close, high: close + 1, low: close - 1, close, volume: 100 };
  }

  it("uses only the last CLOSED daily bar, never a bar in progress", () => {
    // 3 flat daily bars (close 10) then a rising 4th bar (close 20) still in progress
    // at the 4h timestamp under test (4h bar opens exactly when day 4 starts).
    const daily = [d(10, 0 * DAY), d(10, 1 * DAY), d(10, 2 * DAY), d(20, 3 * DAY)];
    // at t = 3*DAY (day 4's bar just opened, not closed yet): last closed is day 3 (idx2)
    const dir = resolveRegimeDir(daily, 3 * DAY, 2);
    // EMA(2) over closes [10,10,10] as of idx2 warms up at idx1 -> value 10; close(idx2)=10 -> tie -> "long" (>=)
    expect(dir).toBe("long");
  });

  it("advances to the newly closed bar once its full day has elapsed", () => {
    const daily = [d(10, 0 * DAY), d(10, 1 * DAY), d(10, 2 * DAY), d(20, 3 * DAY)];
    // at t = 4*DAY: day 4's bar (close 20, opened 3*DAY) is now fully closed
    const dir = resolveRegimeDir(daily, 4 * DAY, 2);
    // EMA(2) over closes [10,10,10,20] as of idx3: seed(idx1)=10, idx2: 10*k+10*(1-k)=10,
    // idx3: 20*k+10*(1-k) with k=2/3 -> 20*0.667+10*0.333≈16.67; close(idx3)=20 > ema -> "long"
    expect(dir).toBe("long");
  });

  it("returns null when EMA hasn't warmed up yet", () => {
    const daily = [d(10, 0 * DAY)];
    expect(resolveRegimeDir(daily, 1 * DAY, 200)).toBeNull();
  });

  it("returns null when no higher-tf candles are supplied", () => {
    expect(resolveRegimeDir(undefined, 5 * DAY, 2)).toBeNull();
    expect(resolveRegimeDir([], 5 * DAY, 2)).toBeNull();
  });

  it("returns short when the last closed bar's close is below its EMA", () => {
    const daily = [d(20, 0 * DAY), d(20, 1 * DAY), d(20, 2 * DAY), d(5, 3 * DAY)];
    const dir = resolveRegimeDir(daily, 4 * DAY, 2);
    expect(dir).toBe("short");
  });
});

describe("judgeClose with regime filter", () => {
  const DAY = 86_400_000;
  function d(close: number, openTime: number): Candle {
    return { openTime, open: close, high: close + 1, low: close - 1, close, volume: 100 };
  }
  const withRegime: Params = {
    ...P,
    filters: { ...P.filters, regime: { on: true, emaPeriod: 2 } },
  };

  it("blocks an entry against the 1d regime", () => {
    // 1d regime clearly bearish (declining closes, well below EMA at the last closed bar)
    const daily = [d(20, 0 * DAY), d(20, 1 * DAY), d(20, 2 * DAY), d(5, 3 * DAY), d(5, 4 * DAY)];
    // 4h candles: breakout LONG signal (from the existing breakout fixture), at t = 5*DAY
    const candles = [
      c(11, 9, 10, 100, 5 * DAY),
      c(12, 10, 11, 100, 5 * DAY + 1),
      c(13, 11, 12, 100, 5 * DAY + 2),
      c(20, 12, 20, 100, 5 * DAY + 3), // breakout bar, long signal
    ];
    const ev = judgeClose(FLAT, candles, withRegime, null, null, daily);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("ENTRY_BLOCKED");
  });

  it("allows an entry aligned with the 1d regime", () => {
    // 1d regime clearly bullish
    const daily = [d(5, 0 * DAY), d(5, 1 * DAY), d(5, 2 * DAY), d(20, 3 * DAY), d(20, 4 * DAY)];
    const candles = [
      c(11, 9, 10, 100, 5 * DAY),
      c(12, 10, 11, 100, 5 * DAY + 1),
      c(13, 11, 12, 100, 5 * DAY + 2),
      c(20, 12, 20, 100, 5 * DAY + 3),
    ];
    const ev = judgeClose(FLAT, candles, withRegime, null, null, daily);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("ENTRY_LONG");
  });
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: FAIL — `resolveRegimeDir`가 아직 없어 import 에러, `judgeClose` 6번째 인자 무시됨.

- [ ] **Step 3: `signals.ts`에 구현 추가**

`packages/core/src/signals.ts` 상단 import에 `Side` 추가:

```ts
import { atr, donchian, ema } from "./indicators.js";
import { allPassed, evaluateFilters } from "./filters.js";
import type { Candle, Params, PosCtx, Side, SignalEvent } from "./types.js";
```

`judgeClose` 함수 정의 위에 새 함수 추가:

```ts
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
```

`judgeClose` 시그니처와 두 `evaluateFilters` 호출부 수정:

```ts
export function judgeClose(
  pos: PosCtx,
  candles: Candle[],
  params: Params,
  funding: number | null,
  oiChangePct: number | null = null,
  higherTfCandles?: Candle[],
): SignalEvent[] {
```

롱 진입 분기의 `evaluateFilters` 호출:

```ts
      const regimeDir = resolveRegimeDir(higherTfCandles, candles[i].openTime, params.filters.regime.emaPeriod);
      const checks = evaluateFilters("long", candles, i, funding, params.filters, oiChangePct, regimeDir);
```

숏 진입 분기의 `evaluateFilters` 호출도 동일 패턴(`regimeDir` 재사용, 같은 `i`이므로 한 번만
계산해도 되지만 두 분기가 서로 배타적으로 실행되므로 각 분기에서 지역적으로 계산해도 무방 —
가독성 우선, 아래처럼 각 분기 시작에서 계산):

```ts
    } else if (close < entryBand.lower - buf && close < emaV) {
      const regimeDir = resolveRegimeDir(higherTfCandles, candles[i].openTime, params.filters.regime.emaPeriod);
      const checks = evaluateFilters("short", candles, i, funding, params.filters, oiChangePct, regimeDir);
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: PASS — 신규 `resolveRegimeDir`/`judgeClose with regime filter` 테스트 전부 green,
기존 테스트도 green(6번째 인자 미공급 시 `undefined` → `resolveRegimeDir` null 반환 → regime
off거나 통과 처리이므로 기존 동작 불변).

- [ ] **Step 5: 전체 회귀 테스트 + 커밋**

Run: `pnpm --filter @turtle/core test`
Expected: PASS — 전체 core 테스트 green.

```bash
git add packages/core/src/signals.ts packages/core/test/signals.test.ts
git commit -m "feat(core): align 1d regime to 4h bars in judgeClose"
```

---

### Task 3: `runBacktest`에 레짐 필터 연동 (O(n) 포인터 방식)

**Files:**
- Modify: `packages/core/src/backtest.ts`
- Modify: `packages/core/test/signals.test.ts` (기존 `describe("runBacktest", ...)` 블록에 추가)

**Interfaces:**
- Consumes: Task 1의 `evaluateFilters(..., regimeDir)`, `ema`(`./indicators.js`)
- Produces: `runBacktest(candles, params, startEquity?, costs?, higherTfCandles?: Candle[]): BacktestResult` (5번째 파라미터 추가)

- [ ] **Step 1: 실패하는 테스트부터 작성**

`packages/core/test/signals.test.ts`의 기존 `describe("runBacktest", () => { ... })` 블록
내부(`it("volume filter reduces...")` 다음)에 새 테스트 추가:

```ts
  it("regime filter blocks a counter-trend entry, passes a trend-aligned one", () => {
    const DAY = 86_400_000;
    const FOUR_HOURS = 14_400_000;
    function d(close: number, openTime: number): Candle {
      return { openTime, open: close, high: close + 1, low: close - 1, close, volume: 100 };
    }
    // trendThenReversal()'s own openTime is a toy sequential counter (0,1,2,...),
    // not real epoch ms -- regime alignment needs real time deltas (ONE_DAY_MS is
    // a hardcoded 86_400_000 inside runBacktest), so remap onto real 4h-spaced
    // timestamps. Only openTime changes; OHLC values (and therefore every
    // indicator/entry/exit decision) are untouched, so the trade itself is
    // identical to the baseline -- only regime gating differs.
    const candles = trendThenReversal().map((cd, idx) => ({ ...cd, openTime: idx * FOUR_HOURS }));
    const withRegime: Params = { ...P, filters: { ...P.filters, regime: { on: true, emaPeriod: 2 } } };
    // entry bar is index 6 (see the "captures a trend trade" test below) ->
    // real openTime = 6*4h = 24h = exactly 1*DAY.

    // bearish 1d regime as of the entry bar -> the long entry must be blocked -> no trades
    const bearishDaily = [d(20, -2 * DAY), d(20, -1 * DAY), d(5, 0)];
    const blocked = runBacktest(candles, withRegime, 1000, undefined, bearishDaily);
    expect(blocked.trades).toHaveLength(0);

    // bullish 1d regime as of the entry bar -> the long entry passes -> same trade as without regime
    const bullishDaily = [d(5, -2 * DAY), d(5, -1 * DAY), d(20, 0)];
    const allowed = runBacktest(candles, withRegime, 1000, undefined, bullishDaily);
    const baseline = runBacktest(candles, P, 1000);
    expect(allowed.trades).toHaveLength(baseline.trades.length);
    expect(baseline.trades).toHaveLength(1); // sanity: exactly one trade exists to gate
  });
```

Note: `trendThenReversal()`은 이 파일에 이미 정의된 함수 — OHLC 값은 그대로 재사용하되
`openTime`만 실제 4h 간격(`idx*14_400_000`)으로 재매핑한다. 진입 인덱스가 6이므로(같은 파일의
"captures a trend trade" 테스트로 이미 확정됨) 진입 시점의 실제 `openTime`은 정확히 `1*DAY`
(6×4h=24h) — `bearishDaily`/`bullishDaily`의 마지막 봉을 `openTime=0`(1일 전)에 둬 진입
시점에 정확히 완결된 1d 봉으로 잡히도록 정렬.

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: FAIL — `runBacktest`가 5번째 인자를 모름(레짐이 항상 무시되어 `blocked.trades`가
0이 아니게 나옴).

- [ ] **Step 3: `backtest.ts`에 구현 추가**

`packages/core/src/backtest.ts` 함수 시그니처 수정:

```ts
export function runBacktest(
  candles: Candle[],
  params: Params,
  startEquity = 10_000_000,
  costs: BacktestCosts = NO_COSTS,
  higherTfCandles: Candle[] = [],
): BacktestResult {
```

함수 본문 상단, `const atrArr = atr(candles, params.atrPeriod);` 다음에 추가:

```ts
  const higherEmaArr = params.filters.regime.on
    ? ema(higherTfCandles.map((c) => c.close), params.filters.regime.emaPeriod)
    : [];
  let regimePtr = -1; // index into higherTfCandles: last CLOSED bar as of the current 4h bar
  const ONE_DAY_MS = 86_400_000;
```

메인 루프 안, `// Flat: entries` 섹션에서 `let dir: Side | null = null;` 앞에 추가:

```ts
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

```

`evaluateFilters` 호출부(기존 `const checks = evaluateFilters(dir, candles.slice(0, i + 1), i, null, cfg);`)를:

```ts
    const checks = evaluateFilters(dir, candles.slice(0, i + 1), i, null, cfg, null, regimeDir);
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/core test -- signals.test.ts`
Expected: PASS.

- [ ] **Step 5: 전체 회귀 테스트 + 커밋**

Run: `pnpm --filter @turtle/core test`
Expected: PASS.

```bash
git add packages/core/src/backtest.ts packages/core/test/signals.test.ts
git commit -m "feat(core): wire regime filter into runBacktest"
```

---

### Task 4: 실시간 엔진 연동 (`apps/engine`)

**Files:**
- Modify: `apps/engine/src/runner.ts`
- Modify: `apps/engine/test/runner.test.ts`

**Interfaces:**
- Consumes: Task 2의 `judgeClose(..., higherTfCandles?)`, `BinanceClient.fetchKlines(symbol, tf, limit)`
- Produces: (없음 — 엔진 내부 배선)

- [ ] **Step 1: 실패하는 테스트부터 작성**

`apps/engine/test/runner.test.ts`의 `describe("processSymbol", ...)` 블록 내부, 기존
첫 번째 테스트 다음에 추가:

```ts
  it("fetches 1d candles for the regime filter only when enabled on a 4h symbol", async () => {
    const now = Math.floor(Date.now() / H4) * H4 + 60_000;
    const lastClosed = lastClosedOpenTime("4h", now);
    const candles = mkCandles(300, lastClosed, true);
    const { repo, binance, deps } = mkDeps(candles);

    const p = repo.getParams("BTCUSDT", "4h");
    p.filters.adx.on = false;
    p.filters.regime.on = true;
    repo.upsertParams("BTCUSDT", "4h", p);

    await processSymbol(deps, "BTCUSDT", "4h", now);

    const tfArgs = binance.fetchKlines.mock.calls.map((call: unknown[]) => call[1]);
    expect(tfArgs).toContain("1d");
  });

  it("does not fetch 1d candles when the regime filter is off", async () => {
    const now = Math.floor(Date.now() / H4) * H4 + 60_000;
    const lastClosed = lastClosedOpenTime("4h", now);
    const candles = mkCandles(300, lastClosed, true);
    const { repo, binance, deps } = mkDeps(candles);

    const p = repo.getParams("BTCUSDT", "4h");
    p.filters.adx.on = false;
    repo.upsertParams("BTCUSDT", "4h", p); // regime stays off (default)

    await processSymbol(deps, "BTCUSDT", "4h", now);

    const tfArgs = binance.fetchKlines.mock.calls.map((call: unknown[]) => call[1]);
    expect(tfArgs).not.toContain("1d");
  });
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `pnpm --filter @turtle/engine test -- runner.test.ts`
Expected: FAIL — `regime.on`이 `true`여도 `fetchKlines`가 `"1d"`로 호출되지 않음(첫 번째
신규 테스트 실패). 두 번째 테스트는 이미 통과할 수도 있음(기존 동작이 애초에 1d를 안
부르므로) — 그래도 함께 커밋해 회귀 방지선으로 남긴다.

- [ ] **Step 3: `runner.ts`에 배선 추가**

`apps/engine/src/runner.ts` 상단 import에 `Candle` 타입 추가:

```ts
import {
  DEFAULT_PORTFOLIO_GATE,
  evaluatePortfolioGate,
  featureSnapshot,
  judgeClose,
  type Candle,
  type GateResult,
  type PortfolioGateConfig,
  type PosCtx,
  type Side,
  type Timeframe,
} from "@turtle/core";
```

`CANDLE_FETCH` 상수 다음에 추가:

```ts
const REGIME_FETCH = 220; // covers EMA200 + margin on daily bars
```

`processSymbol` 함수 내부, 기존 klines/funding/oi fetch 블록을 수정:

```ts
  let candles;
  let funding: number | null;
  let oiChangePct: number | null = null;
  let higherTfCandles: Candle[] | undefined;
  try {
    candles = await binance.fetchKlines(symbol, tf, CANDLE_FETCH);
    funding = await binance.fetchFunding(symbol);
    const params0 = repo.getParams(symbol, tf);
    // OI only fetched when the filter is enabled for this symbol/timeframe.
    if (params0.filters.oi.on) {
      oiChangePct = await binance.fetchOiChangePct(symbol);
    }
    // Regime only meaningful on 4h (1d has no higher timeframe here).
    if (tf === "4h" && params0.filters.regime.on) {
      higherTfCandles = await binance.fetchKlines(symbol, "1d", REGIME_FETCH);
    }
    health.apiOk();
  } catch (e) {
    await health.apiFail(`klines ${symbol} ${tf}: ${(e as Error).message}`);
    return;
  }
```

Note: 기존 코드는 루프 안에서 매 봉마다 `repo.getParams(symbol, tf)`를 다시 불러왔다
(파라미터가 봉 사이에 바뀔 가능성을 열어둔 설계). 위 수정은 fetch 여부 판단에만 fetch
시점의 스냅샷(`params0`)을 쓰고, 실제 판정에 쓰이는 `params`는 루프 안에서 기존 그대로
매번 다시 읽는다 — 동작 변경 없음.

`judgeClose` 호출부 수정:

```ts
    const events = judgeClose(pos, window, params, funding, oiChangePct, higherTfCandles);
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `pnpm --filter @turtle/engine test -- runner.test.ts`
Expected: PASS.

- [ ] **Step 5: 전체 회귀 테스트 + 커밋**

Run: `pnpm test`
Expected: PASS — 전체 워크스페이스 green.

```bash
git add apps/engine/src/runner.ts apps/engine/test/runner.test.ts
git commit -m "feat(engine): fetch 1d candles and apply regime filter on 4h symbols"
```

---

### Task 5: `scripts/backtest.ts` CLI 비교행 + 문서 갱신

**Files:**
- Modify: `scripts/backtest.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 3의 `runBacktest(..., higherTfCandles)`, 기존 `fetchKlines`(스크립트 내부 함수)
- Produces: (없음 — 최상위 CLI)

- [ ] **Step 1: CLI에 레짐 비교행 추가**

`scripts/backtest.ts` 수정. `withFilters` 함수 다음에 헬퍼 추가:

```ts
function withRegime(): Params {
  const p = withFilters({});
  p.filters.regime = { on: true, emaPeriod: 200 };
  return p;
}
```

`combos` 배열에 행 추가(`전부 ON` 앞, 1d 인터벌일 땐 상위TF가 없으므로 제외):

```ts
  const combos: [string, Params][] = [
    ["필터 없음 (원조 터틀)", withFilters({})],
    ["ADX만", withFilters({ adx: true })],
    ["거래량만", withFilters({ volume: true })],
    ["VWAP만", withFilters({ vwap: true })],
    ...(interval !== "1d" ? ([["레짐만(1d)", withRegime()]] as [string, Params][]) : []),
    ["전부 ON", withFilters({ adx: true, volume: true, vwap: true })],
  ];
```

레짐 콤보를 백테스트할 때만 1d 캔들을 추가로 fetch하고, `rows` 계산 시 해당 행에만
`higherTfCandles`를 넘기도록 `rows` 계산부를 수정:

```ts
  let dailyCandles: Candle[] = [];
  if (interval !== "1d" && combos.some(([label]) => label.includes("레짐"))) {
    console.log(`레짐 필터용 1d 캔들 로딩...`);
    dailyCandles = await fetchKlines(symbol, "1d", start, end);
  }

  const rows = combos.map(([label, params]) => {
    const higherTf = label.includes("레짐") ? dailyCandles : [];
    const { stats } = runBacktest(candles, params, 10_000_000, DEFAULT_COSTS, higherTf);
    return {
      조합: label,
      거래수: stats.n,
      "승률%": (stats.winRate * 100).toFixed(1),
      평균R: stats.avgR.toFixed(2),
      PF: Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "inf",
      "MDD%": (stats.mdd * 100).toFixed(1),
      "최종자산(1000만→)": Math.round(stats.endEquity).toLocaleString(),
    };
  });
```

- [ ] **Step 2: 짧은 기간으로 스모크 실행**

Run: `pnpm backtest BTCUSDT 4h 2024-01-01 2024-06-01`
Expected: 콤보 표에 "레짐만(1d)" 행 포함 5행 출력, 에러 없이 종료. 4h가 아닌 `pnpm backtest
BTCUSDT 1d 2022-01-01`은 레짐 행 없이 기존 4행 그대로.

- [ ] **Step 3: `CLAUDE.md` 갱신**

"트레이딩 규칙" 섹션의 "보완 필터" 항목에 레짐 추가:

```
- **보완 필터** (개별 on/off, 진입에만 적용·청산엔 미적용): ADX(14)≥20, 거래량≥1.5×평균, Rolling VWAP(30일) 방향, 펀딩비 ±0.1% 과열 차단, **OI 확인**(24h 미결제약정 증가 = 신규 자금·진짜 돌파, 기본 off), **레짐 확인**(1d 종가 vs 1d EMA200 — 4h 신호가 상위 추세와 같은 방향일 때만 통과, 기본 off, `backtest`로 검증 가능)
```

"PF 개선 로드맵" 섹션 항목 2에 완료 표시:

```
2. ~~**레짐 필터**~~ (완료 2026-07-21) — 상위 타임프레임(1d) 추세방향과 4h 신호 일치 요구하는 멀티타임프레임 필터. 횡보장 손절 반복 완화
```

- [ ] **Step 4: 커밋**

```bash
git add scripts/backtest.ts CLAUDE.md
git commit -m "feat: add regime filter comparison row to backtest CLI"
```

---

## Self-Review Notes

- **Spec coverage:** 타입/필터로직(Task1) · 4h정렬(Task2) · runBacktest연동(Task3) · 엔진연동(Task4) · CLI+문서(Task5) 전부 매핑됨.
- **컴파일 안전성:** `FilterConfig`에 필드 추가 시 깨지는 기존 리터럴(`filters.test.ts`/`signals.test.ts`/`portfolio-backtest.test.ts`/`repo.ts` deep-merge) 전부 Task1에서 한 번에 처리 — 중간 태스크에서 컴파일 깨진 상태로 남지 않음.
- **하위호환:** `evaluateFilters`/`judgeClose`/`runBacktest` 전부 옵션 파라미터 추가라 `sweep.ts`/`crossval.ts`/`portfolio-backtest.ts`/`apps/web` 등 기존 호출부 수정 불필요 — 기본값(`regimeDir=null`/`higherTfCandles=[]`) + `DEFAULT_PARAMS.filters.regime.on=false` 조합으로 기존 동작 그대로 유지.
- **범위 밖(후속 과제):** `scripts/sweep.ts`/`scripts/crossval.ts` 연동, 웹 파라미터 시트(`ParamsSheet.tsx`) UI 토글 — 이번 스코프 아님(브레인스토밍 단계에서 명시적으로 제외 합의). 현재는 DB에 직접 `filters.regime.on=true`로 저장해야 실사용 가능.
- **타입 일관성:** `regimeDir: Side | null`이 `filters.ts`/`signals.ts`/`backtest.ts` 전체에서 동일 이름·타입으로 사용됨.
