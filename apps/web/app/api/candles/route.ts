import { NextResponse, type NextRequest } from "next/server";
import {
  adx,
  atr,
  donchian,
  ema,
  rollingVwap,
  type Candle,
  type Timeframe,
} from "@turtle/core";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;

  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") ?? "BTCUSDT").toUpperCase();
  const tf = (sp.get("tf") ?? "4h") as Timeframe;
  const limitRaw = Number(sp.get("limit") ?? 500);

  // Validate before interpolating into the upstream URL (param-injection guard).
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  if (tf !== "4h" && tf !== "1d") {
    return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });
  }
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000) : 500;

  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!res.ok) {
    return NextResponse.json({ error: `binance ${res.status}` }, { status: 502 });
  }
  const rows = (await res.json()) as unknown[][];
  const candles: Candle[] = rows.map((r) => ({
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));

  const repo = getRepo();
  const params = repo.getParams(symbol, tf);
  const closes = candles.map((c) => c.close);

  // funding (best-effort)
  let funding: number | null = null;
  try {
    const fr = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (fr.ok) {
      const d = (await fr.json()) as { lastFundingRate?: string };
      const v = Number(d.lastFundingRate);
      funding = Number.isFinite(v) ? v : null;
    }
  } catch {
    /* ignore */
  }

  return NextResponse.json({
    symbol,
    tf,
    params,
    funding,
    candles,
    overlays: {
      entryChannel: donchian(candles, params.entryPeriod),
      exitChannel: donchian(candles, params.exitPeriod),
      ema: ema(closes, params.emaPeriod),
      vwap: rollingVwap(candles, params.filters.vwap.bars * (tf === "4h" ? 6 : 1)),
      atr: atr(candles, params.atrPeriod),
      adx: adx(candles, params.filters.adx.period),
    },
  });
}
