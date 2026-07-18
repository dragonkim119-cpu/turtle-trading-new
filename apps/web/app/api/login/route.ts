import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "../../../lib/auth.js";

/** Constant-time password check (hash both to equal length first). */
function passwordMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const { password } = (await req.json()) as { password?: string };
  const expected = process.env.WEB_PASSWORD;
  if (!expected) return NextResponse.json({ ok: true });
  if (typeof password !== "string" || !passwordMatches(password, expected)) {
    return NextResponse.json({ error: "비밀번호가 틀립니다" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("turtle_session", sessionToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
