# 포트폴리오 분산 백테스트 설계

날짜: 2026-07-21
관련 로드맵 항목: CLAUDE.md "PF 개선 로드맵" #1 (포트폴리오 분산 백테스트)

## 배경

`packages/core/src/backtest.ts`의 `runBacktest`는 심볼 1개를 독립 equity로 시뮬레이션한다.
`packages/core/src/portfolio.ts`의 `evaluatePortfolioGate`(오픈리스크캡·일/월 손실 스로틀·방향편중 경고)는
실시간 엔진(`apps/engine`)에서 신호 강등에만 쓰이고, 여러 심볼을 합산한 자산곡선으로
그 효과를 검증하는 백테스트 자체가 없다. 개별 심볼 PF보다 포트폴리오 전체 PF·MDD가
실질적 개선 여지가 크다는 것이 로드맵 평가.

## 목표

1. 다심볼 공유 equity 기반 포트폴리오 백테스트 엔진 추가
2. 실시간 엔진과 동일한 `evaluatePortfolioGate` 로직을 백테스트에 실제 적용(진입 스킵/리스크 절반)해
   게이트가 PF/MDD에 미치는 실질 효과를 검증
3. 게이트 on/off 비교 + 단순합산 대비 공유equity 복리효과 비교를 CLI로 출력

## 비목표

- 심볼 선정 자동화(고정 후보군 4개: BTCUSDT/ETHUSDT/SOLUSDT/BNBUSDT)
- 포지션 상관관계 기반 동적 리스크 조정(향후 로드맵 항목 아님, 현재 게이트 그대로 재현만)
- funding/OI 필터 백테스트 지원(기존 제약 그대로 유지 — 강제 off)

## 아키텍처

### 신규 코어 모듈: `packages/core/src/portfolio-backtest.ts`

```ts
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

export function runPortfolioBacktest(
  inputs: SymbolInput[],
  gateCfg: PortfolioGateConfig,
  startEquity: number,
  costs: BacktestCosts,
  gateEnabled: boolean,
): PortfolioBacktestResult;
```

`packages/core/src/index.ts`에 재export 추가.

### 엔진 알고리즘 (이벤트 드리븐, 단일 전역 시간축)

1. 심볼별 지표 배열(`entryBands`/`exitBands`/`ema`/`atr`) 사전계산. `runBacktest`와 동일한
   `donchian`/`ema`/`atr` 호출 재사용, 로직 재구현 금지(핵심 불변식 — CLAUDE.md).
2. 전 심볼 `candles[].openTime`의 합집합을 만들어 오름차순 정렬 → 전역 타임스텝 배열.
   각 심볼은 `Map<openTime, index>`로 자기 봉 존재 여부/인덱스를 조회.
3. 각 전역 타임스텝 t에서:
   a. **청산 우선 처리** — 그 시각에 봉이 있는 모든 심볼에 대해, 포지션이 열려 있으면
      스톱 → 부분익절 → 채널청산 → 타임스톱 순으로 판정(`runBacktest`의 봉 내부 순서와 동일).
      청산 발생 시 공유 `equity` 갱신, peak/MDD 갱신, UTC 일자(`YYYY-MM-DD`)·월(`YYYY-MM`)
      키의 실현손익 누적 버킷에 `pnlPct` 더함.
   b. **진입 판정** — 그 시각에 봉이 있고 포지션이 없는 심볼에 대해 진입 조건(돈치안 돌파+버퍼,
      EMA, 필터) 통과 시:
      - 현재 열린 포지션 전체로부터 `OpenPos[]` 스냅샷 구성 → `openRiskPct`, `directionCounts`
      - 오늘/이번달 누적 버킷값으로 `PortfolioState.realizedDailyPct`/`realizedMonthlyPct` 구성
      - `evaluatePortfolioGate(dir, state, gateCfg)` 호출
      - `gateEnabled && result.demote` → 진입 스킵, `gateStats.demotedCount++`
      - `result.halveRisk` → 사이징에 riskPct 50% 적용, `gateStats.halvedCount++`
      - 방향편중 warning은 진입에 영향 없음(경고성, 기존 알림 철학 유지)
      - 사이징: `equity × (halveRisk? riskPct/2 : riskPct)% ÷ (stopMult × ATR)`
4. 동일 타임스텝 내 심볼 간 처리 순서는 `inputs` 배열 순서로 고정(결정론적 재현성).
5. `stats`는 전체 `trades`(전 심볼 합산)로 기존 `runBacktest` 집계 로직과 동일하게 계산.
6. `equityCurve`는 트레이드 청산 이벤트마다 `{time, equity}` 기록(기존 MDD 계산 방식과 일관).

### 리스크/비용 모델

기존 `runBacktest`와 동일: 슬리피지·taker fee는 `BacktestCosts`로 편도 반영,
청산 시 `rMultiple`/`pnlPct` 계산 공식 그대로 재사용(중복 구현 금지 — 내부 헬퍼로 추출해
`backtest.ts`와 `portfolio-backtest.ts`가 공유하거나, `portfolio-backtest.ts`에서
동일 공식을 명확히 재현). funding/OI 필터는 기존처럼 강제 off.

### CLI 스크립트: `scripts/backtest-portfolio.ts`

```
pnpm backtest:portfolio [interval=4h] [start=2023-01-01] [end] [--use-saved-params]
```

- 고정 후보군 상수: `["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"]` (수정 가능한 top-level const)
- 각 심볼 klines fetch (기존 스크립트들의 `fetchKlines` 패턴 재사용/중복 — 기존 관례)
- 파라미터: `--use-saved-params`면 심볼별 DB 저장값(`loadSavedParams` 패턴), 아니면
  채택된 기본값(entryPeriod20/exitPeriod15/stopMult2.0/entryBufferAtr0.3/partialTp 1R·50%,
  필터 off)
- 실행 3종 비교 테이블:
  1. 게이트 off (전부 진입, 공유equity만 적용) — 분산효과만 측정
  2. 게이트 on (`DEFAULT_PORTFOLIO_GATE` 적용) — 실전 동일 재현
  3. 참고용 "단순합산": 심볼별 독립 `runBacktest` 최종 equity 수익률 산술평균 vs 위 1/2의 복리 결과
- 출력 컬럼: 거래수, 승률%, PF, MDD%, 최종자산, (게이트 on일 때) 강등횟수/절반사이징횟수
- `package.json`에 `backtest:portfolio` 스크립트 등록

### 테스트: `packages/core/test/portfolio-backtest.test.ts`

손계산 가능한 합성 캔들 시나리오(TDD, 실구현 전 작성):

1. **오픈리스크캡 진입 스킵**: 2심볼, 캔들 조작으로 동시에 리스크 6% 육박하는 포지션들이
   이미 열려 있는 상태에서 3번째 진입 신호 발생 시 게이트 on이면 스킵, off면 진입되는지 대조
2. **일손실 스로틀**: 같은 UTC 일에 손절 누적으로 realizedDailyPct ≤ -4% 도달 후,
   같은 날 이어지는 진입 신호가 스킵되는지 (다음 날로 넘어가면 리셋되는지도 확인)
3. **공유 equity 복리 정확성**: 심볼 A 청산 후 equity 변화가 심볼 B의 다음 진입 사이징에
   반영되는지(순차 의존성 검증)
4. **halveRisk 사이징**: 월손실 스로틀 도달 후 진입 시 qty가 절반 리스크 기준으로
   계산되는지

## 영향 범위

- `packages/core/src/portfolio-backtest.ts` 신규, `index.ts` export 추가
- `packages/core/test/portfolio-backtest.test.ts` 신규
- `scripts/backtest-portfolio.ts` 신규
- `package.json`에 `backtest:portfolio` 스크립트 추가
- `CLAUDE.md` 명령어 표에 새 스크립트 추가, 로드맵 섹션에 진행상황 갱신(완료 시)

기존 `runBacktest`/`portfolio.ts`는 수정하지 않음(순수 함수 재사용만).
