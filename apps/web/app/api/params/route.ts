import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_PARAMS, type Params, type Timeframe } from "@turtle/core";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") ?? "BTCUSDT").toUpperCase();
  const tf = (sp.get("tf") ?? "4h") as Timeframe;
  return NextResponse.json({ params: getRepo().getParams(symbol, tf) });
}

export async function PUT(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const b = (await req.json()) as { symbol: string; tf: Timeframe; params: Params };
  if (!b.symbol || !b.tf || !b.params) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // merge over defaults so missing keys can't corrupt
  const merged: Params = {
    ...structuredClone(DEFAULT_PARAMS),
    ...b.params,
    filters: { ...structuredClone(DEFAULT_PARAMS.filters), ...b.params.filters },
  };
  getRepo().upsertParams(b.symbol.toUpperCase(), b.tf, merged);
  return NextResponse.json({ ok: true });
}
