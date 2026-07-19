import { NextResponse } from "next/server";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

const SYMBOLS = ["DXY", "VIX", "US10Y"];

export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const repo = getRepo();
  const macro = SYMBOLS.map((symbol) => {
    const series = repo.getMacroSeries(symbol, 30);
    const latest = series[series.length - 1] ?? null;
    const prev = series[series.length - 2] ?? null;
    return {
      symbol,
      latest: latest?.value ?? null,
      date: latest?.date ?? null,
      changePct: latest && prev && prev.value ? ((latest.value - prev.value) / prev.value) * 100 : null,
      series: series.map((s) => s.value),
    };
  });
  return NextResponse.json({ macro });
}
