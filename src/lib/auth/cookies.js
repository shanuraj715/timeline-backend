export const ACCESS_COOKIE = "tl_access";
export const REFRESH_COOKIE = "tl_refresh";

const isProd = process.env.NODE_ENV === "production";

// NOTE: Express's res.cookie() `maxAge` is in MILLISECONDS, unlike the
// original Next.js NextResponse cookie API this was ported from, which uses
// SECONDS — the values below are deliberately *1000 versus the source to
// preserve the exact same real expiry (15 minutes / 30 days), not a typo.

export function setAccessCookie(res, token) {
  res.cookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60 * 1000, // 15 minutes, mirrors the JWT's own expiry
  });
}

export function setRefreshCookie(res, token, { rememberMe }) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "strict",
    path: "/api/auth",
    // Omitting maxAge for non-"remember me" logins makes it a session
    // cookie that clears when the browser closes; the Session document's
    // own expiresAt is the durable backstop either way.
    ...(rememberMe ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {}),
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
}
