# CLAUDE.md

터틀 트레이딩 신호 시스템. 바이낸스 선물 대상. 돈치안 돌파 감시 → 텔레그램 알림 → 모바일 웹 대시보드. 알림 전용 (자동 주문 없음).

## 아키텍처

TypeScript pnpm 모노레포. 단일 Railway 컨테이너에서 web + engine 이 SQLite 볼륨 공유.

| 위치 | 역할 |
|---|---|
| `packages/core` | 지표·신호·사이징·백테스트. **단일 진실 공급원** — 웹 차트와 엔진 알림이 같은 함수 사용 |
| `packages/db` | SQLite 스키마 + 타입 저장소(`Repo`). 중복 방지 유니크 키 보장 |
| `apps/engine` | 24h 워커: 봉 마감 판정, 손절 1분 감시, RSS 10분 수집, 텔레그램 |
| `apps/web` | Next.js 14 App Router 모바일 웹. 5탭 + API 라우트 |
| `scripts/` | `backtest.ts`(필터 비교), `sweep.ts`(파라미터 스윕) |

**핵심 불변식**: 지표 계산은 반드시 `packages/core`에만. 웹/엔진 어디서도 지표를 재구현하지 말 것 — 차트 값과 알림 값 불일치의 원천.

## 명령어

```bash
pnpm install
pnpm test                              # 전체 유닛 테스트 (core/db/engine)
pnpm --filter @turtle/core test        # 패키지별 테스트
pnpm --filter @turtle/engine start     # 엔진 (env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DB_PATH)
pnpm --filter @turtle/web dev          # 웹 (기본 포트 3000)
pnpm backtest BTCUSDT 1d 2022-01-01    # 필터 조합 비교표 (구조 파라미터는 클래식 고정)
pnpm backtest:sweep BTCUSDT 4h 2023-01-01  # 진입/청산/손절/버퍼/부분익절 그리드 스윕
pnpm backtest:crossval                 # 후보 파라미터 vs baseline 다심볼·다기간 교차검증
```

웹 빌드: `cd apps/web && npx next build`. 로컬(Windows)은 symlink 권한 없어 standalone 비활성 — Docker 빌드만 `NEXT_STANDALONE=1`.

백테스트 비용: 스크립트(backtest/sweep/crossval)는 `DEFAULT_COSTS`(taker 0.05% + 슬리피지 0.05%, 편도) 반영. `runBacktest` 순수함수 기본값은 무비용(`NO_COSTS`)이라 유닛 테스트는 결정적. 비용 반영 시 PF 전반 하락이 정상(예: BTC 4h 부분익절 1.28→1.15). 여전히 전 조합 PF>1, 부분익절 후보의 기준선 대비 우위 결론 유지.

## 트레이딩 규칙 (기본값)

- **진입**: 종가 > 20봉 돈치안 상단 + **0.3×ATR 버퍼** + 200 EMA 위 + 활성 필터 통과 (숏은 대칭)
- **손절**: 진입가 ∓ 2×ATR(20). 장중 마크가격 1분 감시 (판정만 종가 기준)
- **트레일링/청산**: **15봉** 반대 채널. 스톱은 유리한 방향으로만 이동(래칫)
- **부분 익절**: 1R 도달 시 50% 익절 권고 알림 (손절 모니터가 마크가격 감시). 남은 물량은 트레일링 유지
- **본전 스톱 이동** (`partialTp.moveStopToBreakeven`, 기본 off): 부분익절 후 남은 물량 스톱을 진입가로 래칫 이동. 승률↑·MDD↓ 경향이나 PF 소폭↓(회복 거래 조기 청산) — 심볼별 opt-in
- **리스크**: 거래당 2%. 수량 = 자산×리스크% ÷ (2×ATR)
- **보완 필터** (개별 on/off, 진입에만 적용·청산엔 미적용): ADX(14)≥20, 거래량≥1.5×평균, Rolling VWAP(30일) 방향, 펀딩비 ±0.1% 과열 차단

기본값(청산 15·버퍼 0.3·부분익절 1R/50%)은 교차검증(`backtest:crossval`) 결과 채택 — 승률 6/6 심볼·기간 상승, PF 4/6 개선. 클래식 터틀(청산10·버퍼0·부분익절off)은 `scripts` 백테스트에서 baseline으로 고정 비교.

돈치안은 **직전 N봉**(현재 봉 제외) — `close > upper[i]`가 곧 돌파. 자기 자신 돌파 버그 방지.

**1분 변동성 가드** (방어·알림 전용, 매매신호 생성 안 함): 엔진이 60초마다 워치리스트 심볼의 1m 캔들 조회 → `oneMinAnomaly`(최신 1m 변동이 baseline stdev의 K배 초과 OR 절대 %임계 초과)로 급변 감지 → `⚡` 경보 + `cooldown:<symbol>` 상태 기록. 쿨다운 중 진입 신호는 강등(포트폴리오 게이트와 동일 인프라). 손절 임박(스톱 0.3×initRisk 접근) 선경고도 손절 모니터에 포함. 1분봉을 매매 타임프레임으로 쓰지 않음 — 스캘핑=휩소 방지.

**진입 강등 인프라**: 포트폴리오 리스크(오픈 리스크 캡·손실 스로틀)와 1분 쿨다운이 공유. 강등 = 신호는 발송하되 "비권장" 태그. 차단 아님(알림 전용 철학).

부분 익절 실행 방식: 등록 시 목표가(진입±1R) DB 저장 → 손절 모니터가 마크가격 도달 감지 → `PARTIAL_TP:<posId>` 신호 1회 + 텔레그램 알림 + `partialDone=1`. **알림 전용** — 실제 분할 청산은 사용자가 거래소에서. 백테스트는 R 절반 확정 + 잔여분 트레일링으로 모델링.

## 규약

- ESM. 임포트는 `.js` 확장자로 (`import { x } from "./y.js"`) — 소스는 `.ts`
- TDD: 지표·신호 로직은 손계산 기대값으로 유닛 테스트 먼저
- 저승률·고손익비가 설계 의도. 승률 자체를 목표로 하지 말 것 — 기대값(양수 PF)이 목표
- 커밋: Conventional Commits. main 직접 push
- 문서: `docs/superpowers/specs/`(설계), `docs/superpowers/plans/`(구현 계획)

## 환경변수

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (미설정 시 알림 생략·신호는 DB 기록), `WEB_PASSWORD` (미설정 시 인증 없음·로컬 전용), `DB_PATH` (기본 `data/turtle.db`)

## 배포

Railway: Dockerfile 자동 빌드. Volume `/data` 마운트 + 환경변수 4개. `railway.json`에 restart ALWAYS + healthcheck `/login`.

## 미완/주의

- 부분 익절은 **알림 전용** — 엔진이 1R 도달 알림만 보냄, 실제 분할 청산·잔여 수량 조정은 미자동화(사용자가 거래소에서 직접). 단 본전 스톱 이동은 엔진이 DB stop을 자동 갱신(이후 손절/트레일링 판정에 반영) — 옵션 on일 때만
- 스윕 상위 조합은 **과최적화 주의**. `backtest:crossval`로 다른 기간/심볼 교차검증 후 채택
- 실전 전 1~2주 신호 관찰 운용 권장
