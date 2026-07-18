import { NextResponse, type NextRequest } from "next/server";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

const KEYS = [
  "equity",
  "riskPct",
  "portfolioGate",
  "newsKeywords",
  "notif:entry",
  "notif:exit",
  "notif:stop",
  "notif:trail",
  "notif:blocked",
  "notif:partial",
  "notif:news",
] as const;

export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const repo = getRepo();
  const out: Record<string, string | null> = {};
  for (const k of KEYS) out[k] = repo.getSetting(k);
  return NextResponse.json({ settings: out });
}

export async function PUT(req: NextRequest) {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const body = (await req.json()) as Record<string, string>;
  const repo = getRepo();
  for (const [k, v] of Object.entries(body)) {
    if ((KEYS as readonly string[]).includes(k) && typeof v === "string") {
      repo.setSetting(k, v);
    }
  }
  return NextResponse.json({ ok: true });
}
