# 🐢 Turtle Trading System

바이낸스 선물 대상 터틀 트레이딩 신호 시스템. 돈치안 돌파 감시 → 텔레그램 알림 → 모바일 웹 대시보드.

## 구성

| 위치 | 역할 |
|---|---|
| `packages/core` | 지표 계산·신호 판정·포지션 사이징·백테스트 (웹/엔진 공유 — 값 불일치 원천 차단) |
| `packages/db` | SQLite 스키마 + 저장소 |
| `apps/engine` | 24시간 워커: 봉 마감 감시, 손절 모니터(1분), RSS 뉴스 수집(10분), 텔레그램 발송 |
| `apps/web` | Next.js 모바일 웹: 차트/신호/포지션/뉴스/설정 |

## 트레이딩 규칙 (기본값)

- **진입**: 종가 기준 20봉 돈치안 돌파 + 200 EMA 방향 일치 + 보완 필터 통과
- **손절**: 진입가 ∓ 2×ATR(20) — 장중 마크가격 1분 감시
- **트레일링/청산**: 10봉 반대 채널 (스톱은 유리한 방향으로만 이동)
- **리스크**: 거래당 2% (권장수량 자동 계산)
- **보완 필터** (전부 개별 on/off): ADX(14)≥20 · 거래량≥1.5×평균 · Rolling VWAP(30일) 방향 · 펀딩비 ±0.1% 과열 차단

- **활용 가이드·사용법**: [docs/USAGE.md](docs/USAGE.md)
- **보안 리뷰·배포 체크리스트**: [docs/SECURITY.md](docs/SECURITY.md)
- **상세 설계**: [docs/superpowers/specs/](docs/superpowers/specs/)

## 로컬 실행

```bash
pnpm install
pnpm test                 # 전체 유닛 테스트

# 신호 엔진 (터미널 1)
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... pnpm --filter @turtle/engine start

# 웹 (터미널 2)
pnpm --filter @turtle/web dev   # http://localhost:3000
```

## 백테스트

```bash
pnpm backtest BTCUSDT 1d 2022-01-01 2025-01-01
# 필터 조합별 성과 비교표 출력 (거래수/승률/평균R/PF/MDD)
```

주의: EMA200 계산에 최소 250봉 필요 — 시작일을 충분히 앞당길 것.

## 텔레그램 봇 만들기

1. 텔레그램에서 `@BotFather` → `/newbot` → 토큰 복사 → `TELEGRAM_BOT_TOKEN`
2. 만든 봇에게 아무 메시지 전송 후 `https://api.telegram.org/bot<토큰>/getUpdates` 열어 `chat.id` 확인 → `TELEGRAM_CHAT_ID`

## Railway 배포

1. GitHub 저장소 연결 → 자동으로 Dockerfile 빌드
2. **Volume 추가**: mount path `/data` (SQLite 저장)
3. 환경변수:
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - `WEB_PASSWORD` — 웹 접근 비밀번호
   - `DB_PATH=/data/turtle.db`
4. 도메인 생성 → 모바일에서 접속

## 환경변수

| 이름 | 설명 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather 토큰 (미설정 시 알림 생략, 신호는 DB 기록) |
| `TELEGRAM_CHAT_ID` | 수신 채팅 ID |
| `WEB_PASSWORD` | 웹 비밀번호 (미설정 시 인증 없음 — 로컬 전용) |
| `DB_PATH` | SQLite 경로 (기본 `data/turtle.db`) |

## 운용 권장

실전 투입 전 **1~2주 신호 관찰 운용** 권장. 백테스트로 필터 조합 성과 확인 후 파라미터 확정. 이 시스템은 알림 전용 — 주문 집행은 사용자가 거래소에서 직접.
