import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "../../../lib/auth.js";

export async function POST(req: NextRequest) {
  const { password } = (await req.json()) as { password?: string };
  const expected = process.env.WEB_PASSWORD;
  if (!expected) return NextResponse.json({ ok: true });
  if (password !== expected) {
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
