# design-v2 델타 구현 + 1분 변동성 가드

## Context

현재 저장소(`turtle-trading-new`)는 v1 완성 상태 — 기본 터틀 + 4필터 + 부분익절 + 본전스톱
+ 백테스트/스윕/교차검증 + 모바일 웹 + 텔레그램 엔진, 47 테스트 통과, GitHub 배포 준비됨.

다른 세션에서 만든 `design-v2.md`는 v1의 상위집합(약 90%가 이미 구현됨) + 검증 가능한
신규 항목만 선별 추가한 설계다. 별도 폴더(`crypto-turtle-v01`)는 문서 1개뿐 코드 0줄 —
거기서 새로 시작하면 이미 만들고 테스트한 걸 재작성하는 낭비. **여기서 델타만 얹는다.**

여기에 더해 사용자 요구: BTC의 분단위 급변에 대응. 결론 — 1분봉을 **매매 신호 생성**에
쓰지 않는다(스캘핑=휩소=터틀 철학 위반). 대신 **1분 변동성 가드**(방어·알림 전용):
급변 감지 → 진입 쿨다운 → 손절 임박 선경고. 신호는 4h/1d 유지, 1분은 보호막.

design-v2가 정확히 지적한 결함: **현재 백테스트에 수수료·슬리피지 미반영** → 지금까지의
스윕/교차검증 수치는 낙관 편향. 이걸 최우선으로 고쳐 기존 수치를 재검증한다.

사용자 결정: (1) 1분 = 방어 변동성 가드, (2) v2 델타 = 핵심부터 단계적.

## 불변식 (유지)

- 지표 계산은 `packages/core`에만 (웹 차트 = 엔진 신호 값 일치)
- 알림 전용, 수동 집행. 시스템은 주문 실행 안 함
- 신호 판정 = 봉 마감 종가 기준. 1분/장중은 감시·강등만
- 신규 필터/청산 옵션은 **백테스트 게이트 통과 시에만** 기본 on
- ESM `.js` 임포트, TDD(손계산 기대값 먼저), DB 변경은 additive 마이그레이션

---

## Phase 0 — 설계 문서 반입

- `docs/design-v2.md` 로 design-v2 반입 (경로: `D:\Claude_code\crypto-turtle-v01\docs\design-v2.md` → 저장소 `docs/`)
- 헤더에 "이 저장소 기준 델타는 본 계획 참조" 주석 1줄 추가
- 커밋: `docs: import design-v2 spec`

## Phase 1 — 백테스트 수수료·슬리피지 (최우선, 기존 수치 재검증)

**왜 먼저**: 비용 미반영 백테스트는 무효(design-v2 §10). 모든 후속 채택 결정의 기준선이므로 선행.

**Files**
- `packages/core/src/backtest.ts` — `runBacktest` 옵션 확장
- `packages/core/test/signals.test.ts` — 비용 반영 테스트 추가
- `scripts/backtest.ts`, `scripts/sweep.ts`, `scripts/crossval.ts` — 기본 비용 켜서 재실행

**설계**
- `runBacktest(candles, params, startEquity, costs?)` 에 `costs = { takerPct: 0.05, slippagePct: 0.05 }`(각 편도 %, 기본값) 추가
- 체결가 조정: 롱 진입 `entry*(1+slip)`, 롱 청산 `exit*(1-slip)` (숏 대칭) — 불리한 방향
- 수수료: 진입·청산 각각 `fillPrice * takerPct/100` 차감(왕복 2회)
- 순이동 = (조정청산 − 조정진입)×방향 − 수수료price. `rMultiple = 순이동/initRisk`
- 부분익절 체결분에도 동일 비용 적용(부분 청산 1회 + 잔여 청산 1회 = 수수료 3회)

**검증**: 무비용 vs 비용 반영 백테스트 비교 → PF 하락 확인(정상). `backtest:crossval` 재실행해
기존 "후보 우위" 결론이 비용 반영 후에도 유지되는지 재확인 → USAGE/CLAUDE.md 수치 갱신.

## Phase 2 — feature_snapshot + 실현 R 축적 (저렴·고가치, 지연 시 소급 불가)

**왜 지금**: Phase 2(ML 메타레이블링)용 학습 데이터는 지금부터 안 쌓으면 나중에 복구 불가.
모델은 지금 안 만듦 — 데이터만 축적.

**Files**
- `packages/core/src/features.ts` (신규) — `featureSnapshot(candles, i, funding, oi?)` 순수 함수
- `packages/core/test/features.test.ts` (신규)
- `packages/db/src/schema.ts` — `signals.featureSnapshot` TEXT(JSON) 컬럼 + additive 마이그레이션. `positions.initialRisk` REAL, `positions.realizedR` REAL 컬럼
- `packages/db/src/repo.ts` — `insertSignal`에 featureSnapshot 인자, `openPosition`에 initialRisk 저장, `closePosition`에서 realizedR 계산·저장
- `apps/engine/src/runner.ts` — 진입 신호 시 featureSnapshot 계산해 저장

**설계**
- 스냅샷 필드: ATR, ADX, 거래량배수, VWAP이격률, 펀딩비, (OI변화율 있으면), 200EMA이격률,
  돌파강도`(종가−채널선)/ATR`, 요일, UTC세션. 전부 이미 core에 계산 함수 있음(재사용)
- initialRisk = |entryPrice − 최초 stop| (등록 시 저장). realizedR = (closePrice−entry)×방향/initialRisk (청산 시)
- 기존 마이그레이션 기구 재사용 (`schema.ts`의 `migrate()` — 본전스톱 작업 때 만든 패턴)

**검증**: 유닛 테스트(스냅샷 값 손계산 대조). 엔진 통합 테스트에서 진입 신호 시 featureSnapshot
저장 확인. 포지션 청산 시 realizedR 기록 확인.

## Phase 3 — 진입 강등 인프라 + 포트폴리오 리스크

**왜**: 심볼별 2% 룰만으론 BTC+ETH 동시 = 사실상 한 방향 4% 베팅(상관 0.8+). 계좌 수준 통제.
"집행"이 아니라 신호 강등+경고로 구현(알림 전용 철학). 강등 인프라는 Phase 4 가드와 공유.

**Files**
- `packages/core/src/portfolio.ts` (신규) — 순수 함수: `openRiskPct(positions, equity)`,
  `directionSkew(positions)`, `evaluatePortfolioGate(state, params) → { demote: boolean, reasons: string[] }`
- `packages/core/test/portfolio.test.ts` (신규)
- `packages/db/src/schema.ts` — `portfolio_state`(일/월 누적 손익, 스로틀 상태) 테이블
- `apps/engine/src/runner.ts` — 진입 이벤트 발송 전 포트폴리오 게이트 통과 → 초과 시 `ENTRY_LONG`을
  정보성으로 강등(신규 이벤트 타입 `ENTRY_DEMOTED` + 사유). 공유 헬퍼 `applyEntryGate(event, gates)`
- `apps/engine/src/telegram.ts` — 강등 메시지 포맷 `⚠️ 신호 발생 — 진입 비권장 | 사유: …`
- `apps/web` — 신호 탭 포트폴리오 리스크 카드(오픈리스크/캡, 편중, 스로틀), 설정 탭 임계값

**설계 (design-v2 §4.4)**
- 동시 오픈 리스크 캡 6%(기본), 방향 편중 경고 동일방향 3개, 손실 스로틀 일 −4%/월 −10%
- 스로틀 발동 시 2% 계산기 자동 1% 표시(웹). 상태 배지 상시 표시
- 강등 = 신호 자체는 보냄, "비권장"으로 태그. 차단 아님

**검증**: 포트폴리오 게이트 순수함수 유닛 테스트(캡 초과/편중/스로틀 각 시나리오). 엔진 통합
테스트: 오픈리스크 캡 초과 상태에서 진입 신호가 강등되는지.

## Phase 4 — 1분 변동성 가드 (사용자 핵심 요구, 방어·알림 전용)

**왜**: 4h/1d 시스템은 봉 사이 급변에 눈 감음(손절 감시만). 1분 데이터로 급변 감지 →
기존/대기 신호 보호. 새 매매신호 생성 아님. Phase 3의 강등 인프라 재사용.

**Files**
- `apps/engine/src/binance.ts` — `fetchKlinesRaw(symbol, interval, limit)` (임의 interval 지원, 1m용). 기존 `fetchKlines`는 Timeframe 타입만 받으므로 내부 공유 or 별도 추가
- `packages/core/src/volatility.ts` (신규) — 순수 함수: `oneMinAnomaly(recent1m: Candle[], cfg) → { spike: boolean, pct: number, baseline: number }`
- `packages/core/test/volatility.test.ts` (신규)
- `apps/engine/src/volatilityGuard.ts` (신규) — 60초 루프, 워치리스트 순회, 1m 조회 → 이상 감지 → 알림 + 쿨다운 상태 기록
- `apps/engine/src/runner.ts` — 진입 시 쿨다운 상태 확인 → 활성 시 강등(Phase 3 인프라)
- `apps/engine/src/stopMonitor`(runner.checkStops) — 손절 임박 선경고(스톱 0.3×ATR 접근, 포지션당 1회)
- `apps/engine/src/main.ts` — 가드 루프 등록
- `apps/web` 설정 탭 — 가드 임계값·on/off, 신호 탭 급변 이력 표시

**설계**
1. **이상 감지**: 최근 N개(예 30) 1m 캔들. 최신 1m 수익률 `|Δ%|`이 baseline(최근 1m 수익률
   표준편차 or 평균절대변동)의 K배(기본 4) 초과 OR 절대 임계(기본 1.5%) 초과 → spike
2. **알림**: `⚡ {심볼} 이상변동 — 1분 {±x.x%} (평소 ±{y.y%})`. 유니크 키 (심볼, VOL_SPIKE, 1m봉시각)로 중복 방지
3. **진입 쿨다운**: spike 후 `engine_state.cooldown:<symbol>` = 만료시각(기본 +20분). runner가 진입
   신호 낼 때 쿨다운 활성이면 강등("급변 직후 진입 비권장")
4. **손절 임박 선경고**: checkStops에서 미도달이나 `|mark−stop| < 0.3×initRisk`면 1회 선알림
5. **범위 한정**: API 부하 억제 위해 1m 조회는 워치리스트 심볼만(소수). rate limit 준수

**검증**: `oneMinAnomaly` 유닛 테스트(정상/급등/급락). 가드 통합 테스트: 급변 fixture →
알림 발송 + 쿨다운 기록 + 이후 진입 강등. 손절 임박 선경고 1회성 테스트.

## Phase 5 — 게이트 통과 시에만: OI 필터 · 타임스톱 · 매크로 표시 (후순위)

design-v2 §4.2(OI 필터), §4.3(타임스톱), §5·6.4(매크로 DXY/VIX/금리 표시 전용). 전부 기본 off.
**백테스트 비교표에서 기본 대비 우위 확인 후에만 on 판단.** 매크로는 신호 게이트에 미사용(표시만).

- OI: `packages/core/src/filters.ts`에 5번째 필터, 엔진 `/futures/data/openInterestHist` 수집
- 타임스톱: `signals.ts` + backtest — N봉 내 +1R 미도달 시 청산 권고
- 매크로: 엔진 FRED/Stooq 1일 1회 수집 → `macro_snapshots` 테이블 → 뉴스탭 카드

이 단계는 Phase 1~4 안정화 후 착수. 계획 확정 시 별도 상세화.

---

## 구현 순서 요약

Phase 0(문서) → 1(수수료·재검증) → 2(피처·R 축적) → 3(강등인프라·포트폴리오) →
4(1분 가드) → 5(OI·타임스톱·매크로, 게이트 통과 시).

각 Phase는 독립 커밋 + 테스트 통과 + (웹 변경 시) 빌드 확인. Phase 1은 완료 후 기존
스윕/교차검증 재실행해 문서 수치 갱신.

## 전체 검증

- `pnpm test` — 전 패키지 유닛/통합 (Phase마다 신규 테스트 추가, 회귀 없음 확인)
- `cd apps/web && npx next build` — 웹 변경 Phase마다 타입/빌드 확인
- `pnpm backtest:crossval` — Phase 1 후 비용 반영 재검증
- 엔진 실구동(`pnpm --filter @turtle/engine start`) — Phase 4 후 1분 가드 알림/쿨다운 실동작 확인 (텔레그램 미설정 시 DB·로그로 확인)
- 웹 프리뷰(preview_start) — 포트폴리오 카드·가드 이력 렌더 확인

## 범위 밖 (이번에 안 함)

- ML 모델 학습(Phase 2는 데이터만 축적)
- 1분봉 매매 신호 생성(스캘핑 — 터틀 철학 위반)
- 자동 주문 집행 / 거래소 잔고 연동 / 네이티브 앱 (design-v2 §13 폐기 목록)
- 유료 데이터(온체인·옵션 그릭스) — design-v2 §13
