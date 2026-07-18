import { NextResponse } from "next/server";
import { getRepo } from "../../../lib/db.js";
import { requireAuth } from "../../../lib/api.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;
  const repo = getRepo();
  const health = repo.getState("health");
  return NextResponse.json({
    health: health ? JSON.parse(health) : null,
  });
}
