import { NextResponse, type NextRequest } from "next/server";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;
  return NextResponse.json({ symbols: getRepo().getWatchlist() });
}

export async function POST(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const { symbol } = (await req.json()) as { symbol?: string };
  if (!symbol || !/^[A-Za-z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  getRepo().addSymbol(symbol);
  return NextResponse.json({ symbols: getRepo().getWatchlist() });
}

export async function DELETE(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const { symbol } = (await req.json()) as { symbol?: string };
  if (!symbol) return NextResponse.json({ error: "invalid" }, { status: 400 });
  getRepo().removeSymbol(symbol);
  return NextResponse.json({ symbols: getRepo().getWatchlist() });
}
