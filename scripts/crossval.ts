/**
 * Cross-validation: test a candidate parameter set against the baseline across
 * multiple symbols and periods to check robustness (overfit guard).
 * Usage: pnpm backtest:crossval
 * Edit CANDIDATE / DATASETS below to change what is tested.
 */
import {
  DEFAULT_PARAMS,
  runBacktest,
  type Candle,
  type Params,
} from "../packages/core/src/index.js";

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
    await new Promise((r) => setTimeout(r, 220));
  }
  return out;
}

function baseline(): Params {
  // classic turtle, pinned explicitly so it stays a true baseline even if
  // DEFAULT_PARAMS changes.
  const p = structuredClone(DEFAULT_PARAMS);
  p.entryPeriod = 20;
  p.exitPeriod = 10;
  p.stopMult = 2.0;
  p.entryBufferAtr = 0;
  p.partialTp = null;
  p.filters.adx.on = false;
  p.filters.volume.on = false;
  p.filters.vwap.on = false;
  p.filters.funding.on = false;
  return p;
}

function candidate(): Params {
  const p = baseline();
  p.entryPeriod = 20;
  p.exitPeriod = 15;
  p.stopMult = 2.0;
  p.entryBufferAtr = 0.3;
  p.partialTp = { atR: 1, fraction: 0.5 };
  return p;
}

// symbol, timeframe, start, end
const DATASETS: [string, string, string, string][] = [
  ["BTCUSDT", "4h", "2021-01-01", "2023-01-01"], // out-of-sample period (sweep used 2023-2025)
  ["ETHUSDT", "4h", "2021-01-01", "2023-01-01"],
  ["ETHUSDT", "4h", "2023-01-01", "2025-01-01"],
  ["SOLUSDT", "4h", "2022-01-01", "2024-01-01"],
  ["BNBUSDT", "4h", "2022-01-01", "2024-01-01"],
  ["BTCUSDT", "1d", "2020-01-01", "2025-01-01"],
];

async function main() {
  console.log("교차검증: 후보(20/15/버퍼0.3/부분익절1R50%) vs 기준선(20/10/2.0/off)\n");
  const summary: Record<string, unknown>[] = [];

  for (const [symbol, tf, start, end] of DATASETS) {
    let candles: Candle[];
    try {
      candles = await fetchKlines(
        symbol,
        tf,
        Date.parse(start + "T00:00:00Z"),
        Date.parse(end + "T00:00:00Z"),
      );
    } catch (e) {
      console.log(`${symbol} ${tf} ${start}: fetch 실패 — ${(e as Error).message}`);
      continue;
    }
    if (candles.length < DEFAULT_PARAMS.emaPeriod + 50) {
      console.log(`${symbol} ${tf} ${start}: 캔들 부족(${candles.length}) — 건너뜀`);
      continue;
    }
    const b = runBacktest(candles, baseline()).stats;
    const c = runBacktest(candles, candidate()).stats;
    const fmtPf = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "inf");
    summary.push({
      데이터셋: `${symbol} ${tf} ${start.slice(0, 4)}~${end.slice(0, 4)}`,
      "기준_승률": (b.winRate * 100).toFixed(1),
      "기준_PF": fmtPf(b.profitFactor),
      "기준_MDD": (b.mdd * 100).toFixed(1),
      "후보_승률": (c.winRate * 100).toFixed(1),
      "후보_PF": fmtPf(c.profitFactor),
      "후보_MDD": (c.mdd * 100).toFixed(1),
      "PF개선": Number.isFinite(c.profitFactor) && Number.isFinite(b.profitFactor)
        ? (c.profitFactor - b.profitFactor >= 0 ? "+" : "") + (c.profitFactor - b.profitFactor).toFixed(2)
        : "-",
    });
  }

  console.table(summary);

  const pfWins = summary.filter((r) => String(r["PF개선"]).startsWith("+")).length;
  console.log(
    `\n요약: ${summary.length}개 데이터셋 중 후보 PF가 기준선보다 나은 경우 ${pfWins}개.`,
  );
  console.log("판정 기준: 과반에서 PF 개선 + 승률 상승 + MDD 악화 없음이면 채택 가치 있음.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
