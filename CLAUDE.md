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
pnpm backtest BTCUSDT 1d 2022-01-01    # 필터 조합 비교표
pnpm backtest:sweep BTCUSDT 4h 2023-01-01  # 진입/청산/손절/버퍼/부분익절 그리드 스윕
```

웹 빌드: `cd apps/web && npx next build`. 로컬(Windows)은 symlink 권한 없어 standalone 비활성 — Docker 빌드만 `NEXT_STANDALONE=1`.

## 트레이딩 규칙 (기본값)

- **진입**: 종가 > 20봉 돈치안 상단 + 200 EMA 위 + 활성 필터 통과 (숏은 대칭)
- **손절**: 진입가 ∓ 2×ATR(20). 장중 마크가격 1분 감시 (판정만 종가 기준)
- **트레일링/청산**: 10봉 반대 채널. 스톱은 유리한 방향으로만 이동(래칫)
- **리스크**: 거래당 2%. 수량 = 자산×리스크% ÷ (2×ATR)
- **보완 필터** (개별 on/off, 진입에만 적용·청산엔 미적용): ADX(14)≥20, 거래량≥1.5×평균, Rolling VWAP(30일) 방향, 펀딩비 ±0.1% 과열 차단
- **승률 개선 실험용** (backtest 전용, 실시간 엔진 미지원): `entryBufferAtr`(돌파 버퍼), `partialTp`(부분 익절)

돈치안은 **직전 N봉**(현재 봉 제외) — `close > upper[i]`가 곧 돌파. 자기 자신 돌파 버그 방지.

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

- 부분 익절(`partialTp`)은 백테스트만 — 실시간 엔진은 분할 포지션 미관리
- 스윕 상위 조합은 **과최적화 주의**. 다른 기간/심볼 교차검증 후 채택
- 실전 전 1~2주 신호 관찰 운용 권장
