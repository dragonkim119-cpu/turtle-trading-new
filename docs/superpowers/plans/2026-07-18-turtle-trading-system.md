# Turtle Trading System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Binance futures turtle-trading signal system — engine computes Donchian/ATR/EMA + 4 auxiliary filters, sends Telegram alerts, mobile-first web app shows chart/signals/positions/news.

**Architecture:** TypeScript pnpm monorepo. `packages/core` holds all indicator/signal math (single source of truth). `apps/engine` is a long-running worker (candle close scheduler, stop monitor, RSS collector, Telegram). `apps/web` is Next.js 14 App Router reading the same SQLite DB. Single Railway container runs both processes sharing one SQLite volume.

**Tech Stack:** TypeScript 5, pnpm workspaces, vitest, better-sqlite3, Next.js 14, lightweight-charts v4, node-cron style scheduler (custom setTimeout), Telegram Bot HTTP API (no lib), rss-parser.

## Global Constraints

- All signal judgments use **closed candles only** (spec §4.1); stop-loss touch uses mark price intraday (1-min poll).
- Default params: Donchian entry 20 / exit 10, ATR 20, stop multiple 2.0, EMA 200, risk 2% (spec §4.1).
- Filters (spec §4.2): ADX(14)≥20, volume ≥ 1.5×20-bar avg, Rolling VWAP 30d, funding ±0.1%. Filters gate **entries only**, each independently toggleable per symbol×timeframe.
- Duplicate-send guard: unique key (symbol, timeframe, event, candle open time) (spec §5).
- Timeframes: `4h`, `1d`. Default watchlist: BTCUSDT, ETHUSDT.
- Binance futures public REST only; no API keys for market data.
- Secrets via env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WEB_PASSWORD`, `DB_PATH`.
- Korean UI copy in web/Telegram messages.

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore
packages/core/src/
  types.ts          # Candle, Params, FilterConfig, Signal, PositionState...
  indicators.ts     # ema, atr, donchian, adx, rollingVwap, sma(volume)
  filters.ts        # evaluateFilters(candles, funding, cfg) -> FilterResult[]
  signals.ts        # judgeCandleClose(state, candles, params, filters) -> events
  sizing.ts         # positionSize(equity, riskPct, atr, multiple)
  backtest.ts       # replay(candles, params) -> trades + stats
packages/db/src/
  schema.ts         # DDL + migrations, openDb(path)
  repo.ts           # typed queries (symbols, params, signals, positions, news, engine_state)
apps/engine/src/
  binance.ts        # klines, markPrice, fundingRate fetchers (fetch + backoff)
  scheduler.ts      # candle-close timers per timeframe
  runner.ts         # per close: fetch→judge→persist→notify
  stopMonitor.ts    # 1-min mark price loop while open positions exist
  telegram.ts       # sendMessage w/ retry, message formatters (Korean)
  rss.ts            # feed poll + keyword match
  health.ts         # failure counters, self-alert
  main.ts           # wire-up
apps/web/           # Next.js App Router
  app/(tabs)/chart, signals, positions, news, settings
  app/api/*         # route handlers reading packages/db
  components/TurtleChart.tsx  # lightweight-charts wrapper w/ overlays
  lib/auth.ts       # password cookie middleware
scripts/backtest.ts # CLI entry
Dockerfile, railway.json, README.md
```

---

### Task 1: Monorepo scaffold
**Files:** root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `packages/core/package.json`, `packages/core/tsconfig.json`, vitest config.
- [ ] Scaffold workspace; `pnpm install`; empty `packages/core/src/index.ts`; `pnpm -r test` runs (0 tests OK). Commit.

### Task 2: core types + indicators (TDD)
**Files:** `packages/core/src/types.ts`, `indicators.ts`, `packages/core/test/indicators.test.ts`
**Produces:**
```ts
interface Candle { openTime:number; open:number; high:number; low:number; close:number; volume:number }
ema(values:number[], period:number): (number|null)[]
atr(candles:Candle[], period:number): (number|null)[]        // Wilder smoothing
donchian(candles:Candle[], period:number): {upper:number;lower:number}[]|null[]  // excludes current bar (prior N bars)
adx(candles:Candle[], period:number): (number|null)[]        // Wilder
rollingVwap(candles:Candle[], bars:number): (number|null)[]  // Σ(tp*vol)/Σvol, tp=(h+l+c)/3
smaVolume(candles:Candle[], period:number): (number|null)[]
```
- [ ] Failing tests with hand-computed expected values (small fixtures, 5–30 candles; ATR/ADX cross-checked against known reference series). Donchian MUST use prior-N-bars (exclude current) so breakout compare is `close > donchianUpper[i]`.
- [ ] Implement; tests pass; commit.

### Task 3: core filters + sizing (TDD)
**Files:** `packages/core/src/filters.ts`, `sizing.ts`, tests.
**Produces:**
```ts
interface FilterConfig { adx:{on:boolean;period:number;min:number}; volume:{on:boolean;period:number;mult:number}; vwap:{on:boolean;bars:number}; funding:{on:boolean;maxAbs:number} }
interface FilterCheck { name:'adx'|'volume'|'vwap'|'funding'; passed:boolean; value:number|null; detail:string }
evaluateFilters(dir:'long'|'short', candles:Candle[], i:number, fundingRate:number|null, cfg:FilterConfig): FilterCheck[]
positionSize(equity:number, riskPct:number, atrValue:number, stopMult:number): number  // = equity*riskPct/100/(atrValue*stopMult)
```
Rules: off filter → passed:true. vwap long: close>vwap; short: close<vwap. funding long blocked if rate>+maxAbs; short if rate<−maxAbs. funding null (unavailable) → passed:true with detail.
- [ ] TDD cycle, commit.

### Task 4: core signal judgment (TDD)
**Files:** `packages/core/src/signals.ts`, tests.
**Produces:**
```ts
type Ev = {type:'ENTRY_LONG'|'ENTRY_SHORT';price:number;stop:number;atr:number;filters:FilterCheck[]}
        | {type:'ENTRY_BLOCKED';dir:'long'|'short';filters:FilterCheck[]}
        | {type:'EXIT_LONG'|'EXIT_SHORT';price:number}
        | {type:'TRAIL_UPDATE';newStop:number}
interface PosCtx { side:'long'|'short'|null; entryPrice?:number; stop?:number }
judgeClose(pos:PosCtx, candles:Candle[], params:Params, funding:number|null): Ev[]
```
Logic per spec §4.1/4.2/4.3: EMA200 side gate; breakout vs prior-20 donchian; stop=entry∓2×ATR; trailing = 10-bar opposite extreme when more favorable than current stop (long: `max(stop, exitLower)`); exit when close crosses 10-bar opposite channel. Filters gate entries only. When flat and breakout fires but a filter fails → `ENTRY_BLOCKED`.
Tests: long entry happy path, blocked by ADX, no entry below EMA, trailing ratchets up never down, exit on 10-low close, short mirror.
- [ ] TDD cycle, commit.

### Task 5: backtest (TDD light) + CLI
**Files:** `packages/core/src/backtest.ts`, `scripts/backtest.ts`.
**Produces:** `runBacktest(candles, params, equity):{trades:Trade[]; stats:{n:number;winRate:number;avgR:number;profitFactor:number;mdd:number;endEquity:number}}` — intra-bar stop fill at stop price (conservative: if bar low ≤ stop for long, filled at stop). CLI: `pnpm backtest BTCUSDT 4h 2023-01-01` fetches Binance klines (paginated 1500) and prints comparison table: filters off vs each filter on vs all on.
- [ ] Test on synthetic trend+chop series (asserts: chop series → all-on has fewer trades than all-off). Commit.

### Task 6: packages/db
**Files:** `packages/db/src/schema.ts`, `repo.ts`, test (in-memory `:memory:`).
Tables (spec §8): `symbols(symbol pk, enabled)`, `settings(key pk, value)`, `params(symbol,timeframe pk, json)`, `signals(id, symbol, timeframe, event, candleTime, payload json, delivered, created; UNIQUE(symbol,timeframe,event,candleTime))`, `positions(id, symbol, timeframe, side, entryPrice, qty, stop, status open/closed, stopHistory json, opened, closed)`, `news_items(id, source, title, link UNIQUE, pubDate, matched, keywords)`, `engine_state(key pk, value)`.
Repo produces typed fns used by engine+web: `getWatchlist, upsertParams, getParams, insertSignal(→bool inserted), listSignals, openPosition, updateStop, closePosition, listOpenPositions, insertNews, listNews, getSetting/setSetting, getLastProcessed/setLastProcessed`.
- [ ] TDD (unique-key dedupe test included), commit.

### Task 7: engine — binance client + telegram
**Files:** `apps/engine/src/binance.ts`, `telegram.ts`, tests with mocked fetch.
`fetchKlines(symbol,tf,limit,endTime?)`, `fetchMarkPrice(symbol)`, `fetchFunding(symbol)` — retry ×3 exponential backoff, throw after. `sendTelegram(text)` retry ×3; formatters: `fmtEntry/fmtExit/fmtStopHit/fmtTrail/fmtBlocked/fmtEngineAlert/fmtNews` (Korean, spec §7 format incl. filter status line and position-size line using settings equity/risk).
- [ ] TDD (formatter snapshot tests + retry test), commit.

### Task 8: engine — runner + scheduler + stop monitor + health
**Files:** `apps/engine/src/scheduler.ts`, `runner.ts`, `stopMonitor.ts`, `health.ts`, `main.ts`.
- Scheduler: computes next 4h/1d UTC close, fires at close+30s. Catch-up: on boot compare `engine_state.lastProcessed:<sym>:<tf>` vs latest closed candle; process missed closes sequentially.
- Runner per (symbol,tf): fetch 320 candles (enough for EMA200+VWAP180) + funding → build PosCtx from open position row → `judgeClose` → for each event: `insertSignal` (skip notify if dup) → telegram → on TRAIL_UPDATE also `updateStop` for registered position; on stop-hit/exit for a registered position, alert references position.
- StopMonitor: every 60s while open positions: markPrice vs stop → `STOP_HIT` signal (unique per position id + stop) → telegram.
- Health: consecutive binance failure ≥5 → engine alert telegram (once per hour max); write `engine_state.health`.
- [ ] Integration test with mocked binance returning fixture candles asserting telegram called with entry message + signal row persisted + rerun = no dup. Commit.

### Task 9: engine — RSS collector
**Files:** `apps/engine/src/rss.ts` (+ sources const), test with fixture XML.
Sources: CoinDesk, Cointelegraph, Reuters via Google News RSS query, 연합인포맥스 RSS. Poll 10min. Keyword list from `settings.newsKeywords` (default: 트럼프,Trump,관세,tariff,연준,Fed,금리,전쟁,지정학,제재). Matched → insertNews(matched=1) + telegram if `settings.newsAlerts=='on'`. Dedupe by link UNIQUE.
- [ ] TDD, commit.

### Task 10: web scaffold + auth + API routes
**Files:** `apps/web/*` Next.js 14 App Router, `middleware.ts` password gate (`WEB_PASSWORD` → HMAC cookie), API routes: `/api/candles` (proxy binance + compute overlays via core), `/api/signals`, `/api/positions` (GET/POST/PATCH close), `/api/params` (GET/PUT), `/api/watchlist` (GET/POST/DELETE), `/api/news`, `/api/settings`, `/api/status` (engine health).
- [ ] Login page + one smoke API test; commit.

### Task 11: web — chart tab
**Files:** `components/TurtleChart.tsx`, `app/(tabs)/chart/page.tsx`.
lightweight-charts: candles + line series donchian upper/lower(entry, 청산채널 dashed) + EMA200 + VWAP; markers from signals (▲▼✕); price lines for open position entry/stop. Bottom info bar: ATR/ADX/funding/breakout distance %. Symbol+TF switcher; params bottom-sheet editing `/api/params`. Mobile-first CSS (dark).
- [ ] Manual verify via preview; commit.

### Task 12: web — signals/positions/news/settings tabs
**Files:** respective `page.tsx` + components.
Signals: history list w/ blocked badge + per-symbol state cards. Positions: register from signal (entry/qty prefilled), 2% calculator, open list w/ uPnL(mark from /api), close button. News: calendar = TradingView economic calendar embed iframe; RSS list, matched pinned+badge. Settings: equity, riskPct, watchlist mgmt, notification toggles, keyword editor.
- [ ] Manual verify; commit.

### Task 13: deploy artifacts + README
**Files:** `Dockerfile` (multi-stage, runs `node apps/engine/dist/main.js & next start`), `railway.json`, `README.md` (setup: BotFather, env vars, Railway volume, backtest usage).
- [ ] Build passes locally (`pnpm build`), commit, push.

---

## Self-Review Notes
- Spec §4.1 close-basis, §4.2 four filters entry-only, §4.3 state machine (PosCtx from positions table), §5 dedupe+catch-up+health, §6 four tabs+settings+auth, §7 message formats, §8 schema, §10 backtest CLI — all mapped to tasks 2–13. VWAP bars for 4h = 180 (30d) handled via params json per timeframe.
- Donchian excludes current bar — locked in Task 2 to avoid self-breakout bug.
- Trailing ratchet monotonic — Task 4 test.
