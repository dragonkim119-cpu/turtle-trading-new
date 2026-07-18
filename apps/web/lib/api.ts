import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isValidToken } from "./auth.js";

/** Guard for API route handlers: verifies the session cookie server-side. */
export function requireAuth(): NextResponse | null {
  const token = cookies().get("turtle_session")?.value;
  if (!isValidToken(token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
