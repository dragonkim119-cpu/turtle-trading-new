# 샤데리어(ATR) 트레일링 청산 설계

날짜: 2026-07-23
관련 로드맵 항목: CLAUDE.md "PF 개선 로드맵" #3 (청산 로직 개선)

## 배경

현재 청산은 `exitPeriod` 돈치안 채널(반대편 극값)의 **종가** 이탈로 판정하고, 트레일링은
그 채널 레벨로 스톱을 래칫(유리한 방향으로만)한다. 스윕 결과 청산봉수(15 vs 20)가 진입/손절
파라미터보다 PF에 영향이 컸다 — 봉 개수라는 이산적 파라미터에 성능이 민감하다는 뜻.
ATR 기반 샤데리어(chandelier) 트레일링은 "진입 이후 최고/최저가 ∓ ATR×배수"로 연속적인
변동성 적응형 스톱을 제공, 대안으로 검증한다.

## 목표

1. 옵트인 구조 파라미터 `chandelier`(기본 off)로 추가 — 기존 `partialTp`/`timeStop`과 동일 관례
2. on일 때 기존 `stopMult` 초기스톱 + `exitPeriod` 채널청산/트레일링을 전부 대체
3. `runBacktest`와 실시간 엔진(`judgeClose`) 양쪽에서 동일하게 동작
4. `backtest` CLI로 기존 방식과 비교 검증 가능하게 함

## 비목표

- `scripts/sweep.ts`/`scripts/crossval.ts` 자동 연동 (포트폴리오/레짐 기능과 동일하게 후속 과제로 보류 —
  `crossval.ts`의 `baseline()`/`candidate()` 헬퍼는 수정하지 않음, `chandelier: null` 기본값 유지로
  기존 동작 그대로)
- 필터처럼 개별 진입 게이팅 아님 — 이건 청산 메커니즘 교체

## 판정 방식

**초기 스톱**: 진입봉의 고가(롱)/저가(숏)를 시작점으로, `entryHigh - atrMult×ATR`(롱) /
`entryLow + atrMult×ATR`(숏). 진입가와 진입봉 극값이 다를 수 있어 `atrMult×ATR`과 정확히
같은 거리가 아닐 수 있음 — 실제 샤데리어 정의를 그대로 따른 것으로 의도된 동작.

**리스크 기준**: `initRisk = entryPrice - 초기 샤데리어 스톱`(롱, 절댓값). 부분익절 타겟
(`entryPrice ± atR×initRisk`)·R멀티플 계산 등 기존 로직은 이 `initRisk`를 그대로 사용 —
로직 변경 없음.

**트레일링**: 매 봉마다 "진입 이후 누적 고가/저가"를 갱신하고, 그 값 기준으로 새 스톱
후보를 계산 → 기존 스톱보다 유리한 쪽으로만 이동(래칫, 절대 손해방향으로 안 풀림). ATR은
매 봉 그 시점 값을 재사용(진입시 고정 아님 — 표준 샤데리어 관례).

**이탈**: **자간(intrabar)** — `low <= stop`(롱)/`high >= stop`(숏), 기존 손절 체크 그대로
재사용. `exitReason = "stop"`.

## 아키텍처

### 1. `packages/core/src/types.ts`

```ts
export interface ChandelierConfig {
  atrMult: number; // 기본 3.0 (클래식 샤데리어 관례값)
}

export interface Params {
  // ...기존 필드
  chandelier: ChandelierConfig | null; // null = off (기본값)
}
```

`DEFAULT_PARAMS.chandelier = null`.

### 2. `packages/core/src/backtest.ts` (`runBacktest`)

진입 시(`side = dir` 대입 블록):
- `params.chandelier`가 있으면: `highestSinceEntry = c.high`(롱) 또는 `lowestSinceEntry = c.low`(숏)로 초기화
- `stop`/`initRisk`를 위 "초기 스톱" 공식으로 계산 (기존 `stopMult` 기반 공식 대신)

포지션 보유 중, 매 봉(기존 "채널 이탈 + 트레일링" 블록을 대체):
- `params.chandelier`가 있으면:
  1. `highestSinceEntry = max(highestSinceEntry, c.high)`(롱) — 숏은 대칭
  2. `candidate = highestSinceEntry - params.chandelier.atrMult * atrV`(그 봉의 ATR)
  3. `stop = Math.max(stop, candidate)`(롱, 래칫) — 숏은 `Math.min`
  - 기존 `exitBands`/돈치안 채널 이탈 판정·래칫 블록은 **건너뜀** (이미 위에서 대체)
- 없으면: 기존 로직 그대로 (변경 없음)

기존 자간 스톱 체크(`c.low <= stop` 등)는 변경 없이 그대로 적용 — 샤데리어 스톱이든 채널
스톱이든 같은 체크로 걸림.

### 3. `packages/core/src/types.ts` — `PosCtx`

```ts
export interface PosCtx {
  side: Side | null;
  entryPrice?: number;
  stop?: number;
  entryTime?: number; // 샤데리어 "진입 이후" 구간 스캔에 필요
}
```

### 4. `packages/core/src/signals.ts` (`judgeClose`)

보유 중 분기에서 `params.chandelier`가 있고 `pos.entryTime`이 주어지면:
- `candles.filter(c => c.openTime >= pos.entryTime)`으로 진입 이후 구간만 스캔
- 그 구간의 최고가(롱)/최저가(숏) 계산 → 위와 동일한 공식으로 후보 스톱 계산
- 기존 스톱보다 유리하면 `TRAIL_UPDATE` 이벤트 발행(기존 이벤트 타입 재사용, 값만 다르게)
- 진입 이후 구간에 `low<=stop`인 봉이 있으면(과거 처리 안 된 경우는 없음 — 실시간 엔진은 매
  마감봉마다 호출되므로 해당 없음) 기존 `EXIT_LONG`/`EXIT_SHORT` 로직과 무관 — 손절은 별도
  1분 감시(스톱모니터)가 처리(CLAUDE.md 기존 아키텍처 그대로, 변경 없음)
- 없으면: 기존 로직 그대로

### 5. `apps/engine/src/runner.ts`

`judgeClose` 호출 시 `pos` 구성에 `entryTime: open.openedAt` 추가(한 줄).

### 6. `scripts/backtest.ts`

기존 필터 비교표와 별개로, 구조 비교 섹션(있다면) 또는 새 섹션에 "샤데리어(3×ATR)" 행 추가
— 클래식(돈치안 채널) 대비 거래수/승률/PF/MDD 비교.

### 7. `CLAUDE.md`

- 트레이딩 규칙에 샤데리어 옵션 문서화(기본 off, 옵트인)
- 로드맵 3번 완료 표시

## 테스트 계획

- `signals.test.ts`(`runBacktest` 구역): 합성 캔들로
  1. 상승 트렌드 중 되돌림 시 스톱이 돈치안 대비 다르게(ATR 적응형으로) 트레일되는지
  2. 스톱이 절대 손해방향으로 안 풀리는지(래칫)
  3. 자간 이탈 시 `exitReason==="stop"`인지
  4. `chandelier: null`(기본)일 때 기존 동작과 완전히 동일한지(회귀 없음 — 회귀 테스트 겸용)
- `signals.test.ts`(`judgeClose` 구역):
  1. `entryTime` 이전 캔들의 고점/저점이 무시되는지(진입 전 데이터로 스톱이 과도하게
     느슨해지는 룩백 오염 방지 검증)
  2. `entryTime` 미공급 시(기존 호출부와의 하위호환) 어떻게 동작하는지 — `chandelier` on인데
     `entryTime` 없으면 스캔 구간을 알 수 없으므로 그 호출에서는 트레일 업데이트를 스킵
     (이벤트 없음, 크래시 없음). 채널 로직으로의 폴백은 하지 않음 — 두 메커니즘을 섞으면
     스톱 산출 공식이 봉마다 달라져 일관성이 깨짐. 실제로는 `runner.ts`가 항상 `entryTime`을
     넘기므로 이 경로는 방어적 안전장치일 뿐, 운영 중 발생하지 않음

## 영향 범위

- `packages/core/src/types.ts`, `backtest.ts`, `signals.ts` 수정
- `packages/core/test/signals.test.ts`, `portfolio-backtest.test.ts`(P 픽스처에 `chandelier: null`
  필드 추가 필요 — 리터럴 컴파일 유지, Params에 필드 추가하는 것이므로 regime 때와 동일한
  "리터럴 전부 찾아서 고치기" 패턴 반복)
- `apps/engine/src/runner.ts` 수정
- `scripts/backtest.ts` 수정
- `CLAUDE.md` 갱신

기존 `runBacktest`/`judgeClose` 시그니처 변경 없음(옵션 필드 추가만, `Params`/`PosCtx`
확장) — `sweep.ts`/`crossval.ts`/`portfolio-backtest.ts` 등 기존 호출부는 `chandelier: null`
기본값 덕에 수정 불필요.
