/**
 * Backtest CLI.
 * Usage: pnpm backtest BTCUSDT 4h 2023-01-01 [end]
 * Fetches Binance USDT-M futures klines and prints a filter-combination
 * comparison table (turtle base vs each filter vs all filters).
 */
import { DEFAULT_PARAMS, runBacktest, type Candle, type Params } from "../packages/core/src/index.js";

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
  const p: Params = structuredClone(DEFAULT_PARAMS);
  p.filters.adx.on = overrides.adx ?? false;
  p.filters.volume.on = overrides.volume ?? false;
  p.filters.vwap.on = overrides.vwap ?? false;
  p.filters.funding.on = false; // no historical funding series
  return p;
}

async function main() {
  const [symbol = "BTCUSDT", interval = "4h", startStr = "2023-01-01", endStr] =
    process.argv.slice(2);
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

  const combos: [string, Params][] = [
    ["필터 없음 (원조 터틀)", withFilters({})],
    ["ADX만", withFilters({ adx: true })],
    ["거래량만", withFilters({ volume: true })],
    ["VWAP만", withFilters({ vwap: true })],
    ["전부 ON", withFilters({ adx: true, volume: true, vwap: true })],
  ];

  const rows = combos.map(([label, params]) => {
    const { stats } = runBacktest(candles, params);
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
  console.log("주: 펀딩비 필터는 과거 데이터 부재로 백테스트에서 제외됨 (실시간 엔진에서만 동작).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
