import { NextResponse, type NextRequest } from "next/server";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 100), 500);
  return NextResponse.json({ signals: getRepo().listSignals(limit) });
}
