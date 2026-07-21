/**
 * Portfolio backtest CLI — shared-equity multi-symbol simulation with the
 * live evaluatePortfolioGate applied (entries demoted -> skipped when the
 * gate would flag them). Compares gate off vs on, plus a naive
 * independent-symbol sum for reference.
 * Usage: pnpm backtest:portfolio [interval=4h] [start=2023-01-01] [end] [--use-saved-params]
 */
import path from "node:path";
import {
  DEFAULT_COSTS,
  DEFAULT_PARAMS,
  DEFAULT_PORTFOLIO_GATE,
  runBacktest,
  runPortfolioBacktest,
  type Candle,
  type Params,
  type SymbolInput,
  type Timeframe,
} from "../packages/core/src/index.js";
import { openDb, Repo } from "../packages/db/src/index.js";

const BASE = "https://fapi.binance.com";
// order matters: within one bar, symbols are entry-checked in this order, so
// an earlier symbol gets first claim on the open-risk-cap budget when both
// signal on the same bar (see runPortfolioBacktest's deterministic same-tick
// processing order).
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];

async function fetchKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    const last = Number(rows[rows.length - 1][0]);
    if (last <= cursor) break;
    cursor = last + 1;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

function defaultAdoptedParams(): Params {
  const p = structuredClone(DEFAULT_PARAMS);
  p.filters.adx.on = false;
  p.filters.volume.on = false;
  p.filters.vwap.on = false;
  p.filters.funding.on = false;
  p.filters.oi.on = false;
  return p;
}

function loadSavedParams(symbol: string, timeframe: Timeframe): Params {
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "turtle.db");
  const repo = new Repo(openDb(dbPath));
  const p = repo.getParams(symbol, timeframe);
  p.filters.funding.on = false;
  p.filters.oi.on = false;
  return p;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const useSavedParams = rawArgs.includes("--use-saved-params");
  const [interval = "4h", startStr = "2023-01-01", endStr] = rawArgs.filter(
    (a) => !a.startsWith("--"),
  );
  if (interval !== "4h" && interval !== "1d") {
    throw new Error(`interval must be 4h or 1d, got ${interval}`);
  }
  const start = Date.parse(startStr + "T00:00:00Z");
  const end = endStr ? Date.parse(endStr + "T00:00:00Z") : Date.now();
  if (Number.isNaN(start)) throw new Error(`bad start date: ${startStr}`);

  console.log(`포트폴리오 백테스트: ${SYMBOLS.join(", ")} (${interval}, ${startStr}~${endStr ?? "현재"})\n`);

  const inputs: SymbolInput[] = [];
  for (const symbol of SYMBOLS) {
    console.log(`${symbol} 캔들 로딩...`);
    let candles: Candle[];
    try {
      candles = await fetchKlines(symbol, interval, start, end);
    } catch (e) {
      console.log(`${symbol}: fetch 실패 — ${(e as Error).message}, 건너뜀`);
      continue;
    }
    if (candles.length < DEFAULT_PARAMS.emaPeriod + 50) {
      console.warn(`⚠ ${symbol} 캔들 ${candles.length}개 — 부족, 건너뜀`);
      continue;
    }
    const params = useSavedParams ? loadSavedParams(symbol, interval as Timeframe) : defaultAdoptedParams();
    inputs.push({ symbol, candles, params });
  }
  console.log(`${inputs.length}개 심볼 로드 완료.\n`);

  const fmtPf = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "inf");
  const START_EQUITY = 10_000_000;

  const off = runPortfolioBacktest(inputs, DEFAULT_PORTFOLIO_GATE, START_EQUITY, DEFAULT_COSTS, false);
  const on = runPortfolioBacktest(inputs, DEFAULT_PORTFOLIO_GATE, START_EQUITY, DEFAULT_COSTS, true);

  console.table([
    {
      구성: "게이트 off (공유equity만)",
      거래수: off.stats.n,
      "승률%": (off.stats.winRate * 100).toFixed(1),
      PF: fmtPf(off.stats.profitFactor),
      "MDD%": (off.stats.mdd * 100).toFixed(1),
      최종자산: Math.round(off.stats.endEquity).toLocaleString(),
      강등: "-",
    },
    {
      구성: "게이트 on (실전 재현)",
      거래수: on.stats.n,
      "승률%": (on.stats.winRate * 100).toFixed(1),
      PF: fmtPf(on.stats.profitFactor),
      "MDD%": (on.stats.mdd * 100).toFixed(1),
      최종자산: Math.round(on.stats.endEquity).toLocaleString(),
      강등: `${on.gateStats.demotedCount}회`,
    },
  ]);

  const independentReturns = inputs.map((inp) => {
    const solo = runBacktest(inp.candles, inp.params, START_EQUITY, DEFAULT_COSTS);
    return solo.stats.endEquity / START_EQUITY - 1;
  });
  const avgReturn = independentReturns.reduce((s, r) => s + r, 0) / (independentReturns.length || 1);
  console.log(
    `\n참고: 심볼별 독립 실행 평균 수익률 ${(avgReturn * 100).toFixed(1)}% ` +
      `(공유equity 복리효과 없이 단순 평균 — 위 포트폴리오 결과와 직접 비교 불가, 스케일 참고용).`,
  );
  console.log("주: 수수료+슬리피지 반영, funding/OI 필터는 백테스트에서 강제 off.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
