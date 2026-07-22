/**
 * Backtest CLI.
 * Usage: pnpm backtest BTCUSDT 4h 2023-01-01 [end]
 * Fetches Binance USDT-M futures klines and prints a filter-combination
 * comparison table (turtle base vs each filter vs all filters).
 *
 * With --use-saved-params: runs a single backtest using the symbol's
 * DB-stored params (the ones set via the web chart's ⚙ sheet) instead of
 * the classic-turtle comparison table. OI/funding filters still force off —
 * their history isn't available for backtesting (see CLAUDE.md).
 * Usage: pnpm backtest BTCUSDT 4h 2023-01-01 [end] --use-saved-params
 */
import path from "node:path";
import { DEFAULT_COSTS, DEFAULT_PARAMS, runBacktest, type Candle, type Params, type Timeframe } from "../packages/core/src/index.js";
import { openDb, Repo } from "../packages/db/src/index.js";

const BASE = "https://fapi.binance.com";

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
    await new Promise((r) => setTimeout(r, 250)); // be polite to rate limits
  }
  return out;
}

function withFilters(overrides: Partial<Record<keyof Params["filters"], boolean>>): Params {
  // pin structural params to classic turtle so this table isolates FILTER effect
  // (independent of whatever DEFAULT_PARAMS structural values are)
  const p: Params = structuredClone(DEFAULT_PARAMS);
  p.entryPeriod = 20;
  p.exitPeriod = 10;
  p.stopMult = 2.0;
  p.entryBufferAtr = 0;
  p.partialTp = null;
  p.filters.adx.on = overrides.adx ?? false;
  p.filters.volume.on = overrides.volume ?? false;
  p.filters.vwap.on = overrides.vwap ?? false;
  p.filters.funding.on = false; // no historical funding series
  return p;
}

function withRegime(): Params {
  const p = withFilters({});
  p.filters.regime = { on: true, emaPeriod: 200 };
  return p;
}

function loadSavedParams(symbol: string, timeframe: Timeframe): Params {
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "turtle.db");
  const repo = new Repo(openDb(dbPath));
  const p = repo.getParams(symbol, timeframe);
  // no historical series for these — same constraint as the classic combo table
  p.filters.funding.on = false;
  p.filters.oi.on = false;
  return p;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const useSavedParams = rawArgs.includes("--use-saved-params");
  const [symbol = "BTCUSDT", interval = "4h", startStr = "2023-01-01", endStr] = rawArgs.filter(
    (a) => !a.startsWith("--"),
  );
  const start = Date.parse(startStr + "T00:00:00Z");
  const end = endStr ? Date.parse(endStr + "T00:00:00Z") : Date.now();
  if (Number.isNaN(start)) throw new Error(`bad start date: ${startStr}`);

  console.log(`Fetching ${symbol} ${interval} from ${startStr}...`);
  const candles = await fetchKlines(symbol, interval, start, end);
  console.log(`${candles.length} candles loaded.\n`);
  if (candles.length < DEFAULT_PARAMS.emaPeriod + 50) {
    console.warn(
      `⚠ 캔들 ${candles.length}개 — EMA${DEFAULT_PARAMS.emaPeriod} 계산에 부족. 시작일을 앞당기세요 (최소 ${DEFAULT_PARAMS.emaPeriod + 50}봉 권장).`,
    );
  }

  if (useSavedParams) {
    if (interval !== "4h" && interval !== "1d") {
      throw new Error(`--use-saved-params requires interval 4h or 1d, got ${interval}`);
    }
    const params = loadSavedParams(symbol, interval);
    const { stats } = runBacktest(candles, params, 10_000_000, DEFAULT_COSTS);
    console.log(`저장된 파라미터 (${symbol} ${interval}):`);
    console.log(JSON.stringify(params, null, 2));
    console.table([
      {
        거래수: stats.n,
        "승률%": (stats.winRate * 100).toFixed(1),
        평균R: stats.avgR.toFixed(2),
        PF: Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "inf",
        "MDD%": (stats.mdd * 100).toFixed(1),
        "최종자산(1000만→)": Math.round(stats.endEquity).toLocaleString(),
      },
    ]);
    console.log(`주: 수수료 taker ${DEFAULT_COSTS.takerPct}% + 슬리피지 ${DEFAULT_COSTS.slippagePct}% (편도) 반영.`);
    console.log("주: 펀딩비/OI 필터는 과거 데이터 부재로 backtest에서 강제 off.");
    return;
  }

  const combos: [string, Params][] = [
    ["필터 없음 (원조 터틀)", withFilters({})],
    ["ADX만", withFilters({ adx: true })],
    ["거래량만", withFilters({ volume: true })],
    ["VWAP만", withFilters({ vwap: true })],
    ...(interval !== "1d" ? ([["레짐만(1d)", withRegime()]] as [string, Params][]) : []),
    ["전부 ON", withFilters({ adx: true, volume: true, vwap: true })],
  ];

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
  console.table(rows);
  console.log(`주: 수수료 taker ${DEFAULT_COSTS.takerPct}% + 슬리피지 ${DEFAULT_COSTS.slippagePct}% (편도) 반영.`);
  console.log("주: 펀딩비 필터는 과거 데이터 부재로 백테스트에서 제외됨 (실시간 엔진에서만 동작).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
