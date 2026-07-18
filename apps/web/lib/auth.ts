import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET_SUFFIX = "turtle-session-v1";

export function sessionToken(password: string): string {
  return createHmac("sha256", password + SECRET_SUFFIX).update("session").digest("hex");
}

export function isValidToken(token: string | undefined): boolean {
  const pw = process.env.WEB_PASSWORD;
  if (!pw) return true; // no password configured -> open (local dev)
  if (!token) return false;
  const expected = sessionToken(pw);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
