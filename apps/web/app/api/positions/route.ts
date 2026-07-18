import { NextResponse, type NextRequest } from "next/server";
import type { Side, Timeframe } from "@turtle/core";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;
  return NextResponse.json({ positions: getRepo().listPositions(100) });
}

export async function POST(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const b = (await req.json()) as {
    symbol: string;
    timeframe: Timeframe;
    side: Side;
    entryPrice: number;
    qty: number;
    stop: number;
  };
  if (!b.symbol || !b.side || !(b.entryPrice > 0) || !(b.qty > 0) || !(b.stop > 0)) {
    return NextResponse.json({ error: "invalid position" }, { status: 400 });
  }
  const repo = getRepo();
  const symbol = b.symbol.toUpperCase();
  if (repo.getOpenPosition(symbol, b.timeframe)) {
    return NextResponse.json({ error: "이미 해당 심볼/타임프레임에 열린 포지션이 있습니다" }, { status: 409 });
  }
  // Compute the partial take-profit target from the registered risk (|entry-stop|)
  // and the symbol's partialTp config, so the stop monitor can alert at 1R.
  const params = repo.getParams(symbol, b.timeframe);
  let partialTpTarget: number | null = null;
  if (params.partialTp) {
    const risk = Math.abs(b.entryPrice - b.stop);
    partialTpTarget =
      b.side === "long"
        ? b.entryPrice + params.partialTp.atR * risk
        : b.entryPrice - params.partialTp.atR * risk;
  }
  const id = repo.openPosition({ ...b, symbol, partialTpTarget });
  return NextResponse.json({ id });
}

export async function PATCH(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const b = (await req.json()) as { id: number; closePrice: number; reason?: string };
  if (!b.id || !(b.closePrice > 0)) {
    return NextResponse.json({ error: "invalid close" }, { status: 400 });
  }
  getRepo().closePosition(b.id, b.closePrice, b.reason ?? "manual");
  return NextResponse.json({ ok: true });
}
