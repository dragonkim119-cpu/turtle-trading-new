/**
 * Cross-validation: test a candidate parameter set against the baseline across
 * multiple symbols and periods to check robustness (overfit guard).
 * Usage: pnpm backtest:crossval
 * Edit CANDIDATE / DATASETS below to change what is tested.
 *
 * With --use-saved-params: adds a per-dataset column using that symbol's
 * DB-stored params (the web chart's ⚙ sheet) as a third comparison alongside
 * baseline/candidate. Falls back to DEFAULT_PARAMS if nothing was ever saved
 * for that symbol/timeframe. OI/funding still force off (no backtest history).
 * Usage: pnpm backtest:crossval --use-saved-params
 */
import path from "node:path";
import {
  DEFAULT_PARAMS,
  runBacktest,
  DEFAULT_COSTS,
  type Candle,
  type Params,
  type Timeframe,
} from "../packages/core/src/index.js";
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

function loadSavedParams(symbol: string, timeframe: Timeframe): Params {
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "turtle.db");
  const repo = new Repo(openDb(dbPath));
  const p = repo.getParams(symbol, timeframe);
  // no historical series for these — same constraint as baseline/candidate
  p.filters.funding.on = false;
  p.filters.oi.on = false;
  p.filters.regime.on = false; // no daily candles threaded through crossval yet — would silently no-op otherwise
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
  const useSavedParams = process.argv.slice(2).includes("--use-saved-params");
  console.log("교차검증: 부분익절(20/15/버퍼0.3) — 본전이동 off vs on, 기준선(20/10/2.0/off) 대비\n");
  if (useSavedParams) {
    console.log("--use-saved-params: 데이터셋별 DB 저장 파라미터를 추가 컬럼으로 비교합니다.\n");
  }
  const summary: Record<string, unknown>[] = [];
  const tsSummary: Record<string, unknown>[] = [];

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
    const row: Record<string, unknown> = {
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
    };
    if (useSavedParams && (tf === "4h" || tf === "1d")) {
      const saved = runBacktest(candles, loadSavedParams(symbol, tf), 10_000_000, DEFAULT_COSTS).stats;
      row["저장_승률"] = (saved.winRate * 100).toFixed(1);
      row["저장_PF"] = fmtPf(saved.profitFactor);
      row["저장_MDD"] = (saved.mdd * 100).toFixed(1);
    }
    summary.push(row);

    // Time-stop gate: adopted DEFAULT_PARAMS with vs without timeStop (bars 8/12).
    const def = () => {
      const p = structuredClone(DEFAULT_PARAMS);
      p.filters.adx.on = false;
      p.filters.volume.on = false;
      p.filters.vwap.on = false;
      p.filters.funding.on = false;
      return p;
    };
    const noTs = runBacktest(candles, def(), 10_000_000, DEFAULT_COSTS).stats;
    const ts8 = runBacktest(candles, { ...def(), timeStop: { bars: 8 } }, 10_000_000, DEFAULT_COSTS).stats;
    const ts12 = runBacktest(candles, { ...def(), timeStop: { bars: 12 } }, 10_000_000, DEFAULT_COSTS).stats;
    tsSummary.push({
      데이터셋: `${symbol} ${tf} ${start.slice(0, 4)}~${end.slice(0, 4)}`,
      "기본_PF": fmtPf(noTs.profitFactor),
      "기본_MDD": (noTs.mdd * 100).toFixed(1),
      "TS8_PF": fmtPf(ts8.profitFactor),
      "TS8_MDD": (ts8.mdd * 100).toFixed(1),
      "TS12_PF": fmtPf(ts12.profitFactor),
      "TS12_MDD": (ts12.mdd * 100).toFixed(1),
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

  console.log("\n═══ 타임스톱 게이트 (기본값 vs +타임스톱 8/12봉) ═══");
  console.table(tsSummary);
  const tsGood = tsSummary.filter(
    (r) => Number(r["TS12_PF"]) >= Number(r["기본_PF"]) || Number(r["TS8_PF"]) >= Number(r["기본_PF"]),
  ).length;
  console.log(`요약: ${tsSummary.length}개 중 타임스톱(8 or 12봉)이 PF 유지/개선 ${tsGood}개.`);
  console.log("판정: 다수 데이터셋에서 PF 개선 + MDD 감소면 채택. 아니면 기본 off 유지(옵션만).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
