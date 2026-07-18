/**
 * Cross-validation: test a candidate parameter set against the baseline across
 * multiple symbols and periods to check robustness (overfit guard).
 * Usage: pnpm backtest:crossval
 * Edit CANDIDATE / DATASETS below to change what is tested.
 */
import {
  DEFAULT_PARAMS,
  runBacktest,
  DEFAULT_COSTS,
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

/** partial TP without breakeven stop move */
function candidate(): Params {
  const p = baseline();
  p.entryPeriod = 20;
  p.exitPeriod = 15;
  p.stopMult = 2.0;
  p.entryBufferAtr = 0.3;
  p.partialTp = { atR: 1, fraction: 0.5, moveStopToBreakeven: false };
  return p;
}

/** same, but move the stop to breakeven after the partial fills */
function candidateBE(): Params {
  const p = candidate();
  p.partialTp = { atR: 1, fraction: 0.5, moveStopToBreakeven: true };
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
  console.log("교차검증: 부분익절(20/15/버퍼0.3) — 본전이동 off vs on, 기준선(20/10/2.0/off) 대비\n");
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
    const b = runBacktest(candles, baseline(), 10_000_000, DEFAULT_COSTS).stats;
    const c = runBacktest(candles, candidate(), 10_000_000, DEFAULT_COSTS).stats;
    const be = runBacktest(candles, candidateBE(), 10_000_000, DEFAULT_COSTS).stats;
    const fmtPf = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "inf");
    summary.push({
      데이터셋: `${symbol} ${tf} ${start.slice(0, 4)}~${end.slice(0, 4)}`,
      "기준_PF": fmtPf(b.profitFactor),
      "익절_승률": (c.winRate * 100).toFixed(1),
      "익절_PF": fmtPf(c.profitFactor),
      "익절_MDD": (c.mdd * 100).toFixed(1),
      "본전_승률": (be.winRate * 100).toFixed(1),
      "본전_PF": fmtPf(be.profitFactor),
      "본전_MDD": (be.mdd * 100).toFixed(1),
      "본전효과PF": Number.isFinite(be.profitFactor) && Number.isFinite(c.profitFactor)
        ? (be.profitFactor - c.profitFactor >= 0 ? "+" : "") + (be.profitFactor - c.profitFactor).toFixed(2)
        : "-",
    });
  }

  console.table(summary);

  const beWins = summary.filter((r) => String(r["본전효과PF"]).startsWith("+")).length;
  const beMddBetter = summary.length; // reported per-row; qualitative summary below
  console.log(
    `\n요약: ${summary.length}개 중 본전이동이 부분익절-단독 대비 PF 개선 ${beWins}개.`,
  );
  console.log("본전이동은 보통 MDD를 낮추고 손실거래를 무손실로 바꿈 — 큰 추세 잔여물량을 일찍 털 위험은 트레이드오프.");
  console.log("판정: MDD 개선 + PF 유지/개선이면 채택.");
  void beMddBetter;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
