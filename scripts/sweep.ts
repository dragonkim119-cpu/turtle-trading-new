/**
 * Parameter sweep for the turtle system.
 * Usage: pnpm backtest:sweep BTCUSDT 4h 2023-01-01 [end]
 *
 * Grid: entryPeriod × exitPeriod × stopMult × entryBufferAtr × partialTp.
 * Auxiliary filters are OFF for a clean structural comparison (funding has no
 * historical series anyway). Partial TP is backtest-only for now — the live
 * engine does not yet manage split positions.
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
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

const ENTRY = [20, 40, 55];
const EXIT = [10, 15, 20];
const STOP = [2, 2.5, 3];
const BUFFER = [0, 0.3];
const PARTIAL: (null | { atR: number; fraction: number; moveStopToBreakeven: boolean })[] = [
  null,
  { atR: 1, fraction: 0.5, moveStopToBreakeven: false },
  { atR: 1, fraction: 0.5, moveStopToBreakeven: true },
];

function makeParams(
  entryPeriod: number,
  exitPeriod: number,
  stopMult: number,
  entryBufferAtr: number,
  partialTp: { atR: number; fraction: number; moveStopToBreakeven: boolean } | null,
): Params {
  const p = structuredClone(DEFAULT_PARAMS);
  p.entryPeriod = entryPeriod;
  p.exitPeriod = exitPeriod;
  p.stopMult = stopMult;
  p.entryBufferAtr = entryBufferAtr;
  p.partialTp = partialTp;
  p.filters.adx.on = false;
  p.filters.volume.on = false;
  p.filters.vwap.on = false;
  p.filters.funding.on = false;
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
  console.log(`${candles.length} candles loaded. Sweeping ${ENTRY.length * EXIT.length * STOP.length * BUFFER.length * PARTIAL.length} combos...\n`);

  interface Row {
    진입: number;
    청산: number;
    손절x: number;
    버퍼: number;
    부분익절: string;
    거래수: number;
    승률: number;
    평균R: number;
    PF: number;
    MDD: number;
    최종: number;
  }
  const rows: Row[] = [];

  for (const e of ENTRY)
    for (const x of EXIT)
      for (const s of STOP)
        for (const b of BUFFER)
          for (const pt of PARTIAL) {
            const { stats } = runBacktest(candles, makeParams(e, x, s, b, pt), 10_000_000, DEFAULT_COSTS);
            rows.push({
              진입: e,
              청산: x,
              손절x: s,
              버퍼: b,
              부분익절: pt
                ? `${pt.atR}R/${pt.fraction * 100}%${pt.moveStopToBreakeven ? "+BE" : ""}`
                : "off",
              거래수: stats.n,
              승률: Math.round(stats.winRate * 1000) / 10,
              평균R: Math.round(stats.avgR * 100) / 100,
              PF: Number.isFinite(stats.profitFactor)
                ? Math.round(stats.profitFactor * 100) / 100
                : 999,
              MDD: Math.round(stats.mdd * 1000) / 10,
              최종: Math.round(stats.endEquity),
            });
          }

  const valid = rows.filter((r) => r.거래수 >= 10); // too few trades = not meaningful
  const skipped = rows.length - valid.length;

  const byPf = [...valid].sort((a, b) => b.PF - a.PF);
  const byWin = [...valid].sort((a, b) => b.승률 - a.승률);

  console.log("═══ PF(손익비) 상위 12 ═══");
  console.table(byPf.slice(0, 12));
  console.log("═══ 승률 상위 12 ═══");
  console.table(byWin.slice(0, 12));
  console.log("═══ PF 하위 5 (피해야 할 조합) ═══");
  console.table(byPf.slice(-5));
  console.log(
    `기준선(현재 기본값 20/10/2.0/버퍼0/부분익절off):`,
  );
  console.table(
    valid.filter(
      (r) => r.진입 === 20 && r.청산 === 10 && r.손절x === 2 && r.버퍼 === 0 && r.부분익절 === "off",
    ),
  );
  if (skipped > 0) console.log(`주: 거래수 10건 미만 조합 ${skipped}개 제외됨.`);
  console.log("주: 보조 필터 전부 OFF 상태의 구조 비교. 부분익절은 현재 백테스트 전용(실시간 엔진 미지원).");
  console.log("주: 과최적화 주의 — 상위 조합은 다른 기간/심볼로 교차 검증 후 채택할 것.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
