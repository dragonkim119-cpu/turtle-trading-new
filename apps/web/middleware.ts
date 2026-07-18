import { NextResponse, type NextRequest } from "next/server";

// Note: middleware runs on the edge runtime — no node:crypto. We only check
// cookie presence/shape here; real verification happens in API routes and
// the login route issues the HMAC cookie. For a single-user tool this gate
// plus server-side verification on every API route is sufficient.
export function middleware(req: NextRequest) {
  if (!process.env.WEB_PASSWORD) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/api/login")) {
    return NextResponse.next();
  }
  const token = req.cookies.get("turtle_session")?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
