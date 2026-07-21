# 레짐 필터 설계

날짜: 2026-07-21
관련 로드맵 항목: CLAUDE.md "PF 개선 로드맵" #2 (레짐 필터)

## 배경

현재 필터(ADX/거래량/VWAP/펀딩/OI)는 전부 신호 타임프레임 자체의 데이터만으로 판정한다.
상위 타임프레임 추세 방향과 무관하게 진입이 나가므로, 큰 그림에서 하락 추세인데 4h
단기 반등을 잡는 등 횡보·역추세 구간의 손절 반복이 그대로 남는다. 로드맵 평가: "레짐
구분 없음(횡보장 손절반복 약점 그대로)".

## 목표

1. 상위 타임프레임(1d) 추세 방향과 신호 타임프레임(4h) 진입 방향이 일치할 때만 진입 허용하는
   `regime` 필터 추가
2. 기존 필터와 동일한 개별 on/off, 진입에만 적용(청산엔 미적용) 관례 유지
3. 코어(순수함수) + backtest CLI + 실시간 엔진까지 연동해 실제로 검증·운용 가능하게 함

## 비목표

- 1d 신호 자체의 상위 타임프레임 필터(주봉 등) — 4h→1d 방향만
- 레짐 판정 방식 다양화(돈치안 방향 등) — 1d 종가 vs 1d EMA 단일 방식만
- `backtest:sweep`/`backtest:crossval` 스크립트 연동 — 후속 작업

## 판정 방식

**레짐 방향** = 직전 완결된 1d 봉의 종가가 그 시점 1d EMA(`regimeEmaPeriod`, 기본 200) 위/아래.
위 = 상승 레짐(long만 통과), 아래 = 하락 레짐(short만 통과).

**시간 정렬**: 4h 봉 인덱스 `i`(openTime = `t4h`) 판정 시, 1d 배열에서
`d.openTime + 86_400_000 <= t4h`를 만족하는 가장 최근 1d 봉만 사용. 아직 진행 중이거나
미래인 1d 봉은 절대 참조하지 않음(look-ahead 방지).

**데이터 부족**: 1d EMA가 아직 null(웜업 부족)이거나 `higherTfCandles`가 아예 공급되지
않으면(예: 1d 타임프레임 자체 신호 판정 시) 레짐 필터는 **통과 처리** — 기존 funding/oi의
"조회 불가 → 통과" 관례와 동일.

## 아키텍처

### 1. `packages/core/src/types.ts`

```ts
export interface FilterConfig {
  adx: { on: boolean; period: number; min: number };
  volume: { on: boolean; period: number; mult: number };
  vwap: { on: boolean; bars: number };
  funding: { on: boolean; maxAbs: number };
  oi: { on: boolean; minChangePct: number };
  regime: { on: boolean; emaPeriod: number };
}
```

`DEFAULT_PARAMS.filters.regime = { on: false, emaPeriod: 200 }` — 기본 off, crossval 게이트
통과 전까지 옵트인.

### 2. `packages/core/src/filters.ts`

`evaluateFilters`에 파라미터 추가:

```ts
export function evaluateFilters(
  dir: Side,
  candles: Candle[],
  i: number,
  funding: number | null,
  cfg: FilterConfig,
  oiChangePct: number | null = null,
  regimeDir: Side | null = null,
): FilterCheck[]
```

새 체크 블록(기존 5개 필터 블록과 동일 패턴):

```ts
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
```

`FilterCheck["name"]` 유니온에 `"regime"` 추가.

### 3. `packages/core/src/signals.ts` — 정렬 헬퍼 + `judgeClose` 연동

새 export 함수:

```ts
export function resolveRegimeDir(
  higherTfCandles: Candle[] | undefined,
  atOpenTime: number,
  emaPeriod: number,
): Side | null {
  if (!higherTfCandles || higherTfCandles.length === 0) return null;
  const ONE_DAY_MS = 86_400_000;
  let lastClosedIdx = -1;
  for (let j = 0; j < higherTfCandles.length; j++) {
    if (higherTfCandles[j].openTime + ONE_DAY_MS <= atOpenTime) lastClosedIdx = j;
    else break; // candles assumed sorted ascending by openTime
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

`judgeClose` 시그니처에 `higherTfCandles?: Candle[]` 추가, 진입 분기(롱/숏 둘 다)에서
`evaluateFilters` 호출 직전 `resolveRegimeDir(higherTfCandles, candles[i].openTime, params.filters.regime.emaPeriod)`
계산해 넘김.

주의: `resolveRegimeDir`을 매 봉마다 전체 `ema()` 재계산하는 건 O(n) per call이라
`judgeClose`(단일 봉 판정, 실시간 엔진에서 봉마감마다 1회 호출)에는 무해하지만
`runBacktest`(전 구간 순회)에서 그대로 쓰면 O(n²)이 된다 — **`runBacktest`는 별도로
1d EMA 배열을 사전계산하고 포인터 방식으로 정렬**(아래 4번 참고), `resolveRegimeDir`은
`judgeClose`/실시간 엔진 전용 경량 버전으로 유지.

### 4. `packages/core/src/backtest.ts` — `runBacktest` 연동 (O(n) 정렬)

`runBacktest`에 `higherTfCandles: Candle[] = []` 옵션 파라미터 추가. 함수 시작부에서:

```ts
const higherEmaArr = params.filters.regime.on
  ? ema(higherTfCandles.map((c) => c.close), params.filters.regime.emaPeriod)
  : [];
let regimePtr = -1; // index into higherTfCandles: last CLOSED bar as of current 4h bar
```

메인 루프(진입 분기 직전, 매 `i`마다 한 번) — 포인터를 앞으로만 전진(양쪽 정렬된 배열이므로
역행 불필요):

```ts
if (params.filters.regime.on) {
  while (
    regimePtr + 1 < higherTfCandles.length &&
    higherTfCandles[regimePtr + 1].openTime + 86_400_000 <= c.openTime
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

`evaluateFilters(dir, candles, i, null, cfg, null, regimeDir)` 호출 시 전달(기존
funding/oi 강제 off 자리 그대로, regimeDir만 추가).

### 5. `apps/engine/src/runner.ts` — 실시간 연동

`processSymbol`에서 `tf === "4h"`이고 `repo.getParams(symbol, tf).filters.regime.on`이면:

```ts
let higherTfCandles: Candle[] | undefined;
if (tf === "4h" && repo.getParams(symbol, tf).filters.regime.on) {
  higherTfCandles = await binance.fetchKlines(symbol, "1d", 220);
}
```

`judgeClose(pos, window, params, funding, oiChangePct, higherTfCandles)` 호출부에 추가.
1d 처리 시(`tf === "1d"`)는 `higherTfCandles` 미공급 → 자동 pass, 코드 분기 불필요.

### 6. `scripts/backtest.ts` — CLI 비교행

기존 필터 콤보 표(ADX만/거래량만/VWAP만/전부 ON)에 "레짐만" 행 추가. `withFilters`
헬퍼가 구조 파라미터를 클래식으로 고정하는 것과 별개로, 레짐 행일 때만 1d 캔들을
추가 fetch해서 `runBacktest`에 전달. `interval !== "1d"`일 때만 레짐 행 활성화
(1d 백테스트 자체엔 상위TF 없음).

## 테스트 계획

- `filters.test.ts`: regime on + regimeDir 일치/불일치/null(데이터부족→통과) 3케이스
- `signals.test.ts`: `resolveRegimeDir` — 정확히 직전 완결봉만 쓰는지(진행 중 1d봉 배제),
  EMA 웜업 부족 시 null 반환, 상승/하락 판정 정확성
- `backtest.test.ts`류: `runBacktest`에 합성 1d 상승 레짐 + 4h 역추세(숏) 신호 조합으로
  레짐 필터가 그 진입을 실제로 차단하는지, 순방향(롱) 신호는 통과하는지

## 영향 범위

- `packages/core/src/types.ts`, `filters.ts`, `signals.ts`, `backtest.ts` 수정
- `packages/core/test/filters.test.ts`, `signals.test.ts`, 백테스트 테스트 파일 수정
- `apps/engine/src/runner.ts` 수정
- `scripts/backtest.ts` 수정
- `CLAUDE.md` 트레이딩 규칙(보완 필터 목록) + 로드맵 섹션 갱신

기존 `evaluateFilters`/`judgeClose`/`runBacktest` 시그니처는 옵션 파라미터 추가라
하위호환 유지(기존 호출부는 수정 불필요, 다만 `sweep.ts`/`crossval.ts`는 이번 범위
밖이라 regime은 항상 off로 남음 — 문제 없음, `DEFAULT_PARAMS` 기본 off이므로 기존
동작 그대로).
