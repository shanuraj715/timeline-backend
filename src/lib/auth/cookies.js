export const ACCESS_COOKIE = "tl_access";
export const REFRESH_COOKIE = "tl_refresh";

const isProd = process.env.NODE_ENV === "production";

// Shared with routes/auth.js's Google OAuth callback (the one flow where a
// cookie set on one subdomain must survive landing back on another) and used
// below so logout clears whichever variant — host-only or cross-subdomain —
// the session actually got. Bare "localhost" (local dev) has no dot-able
// parent domain and doesn't need one: ports already share a cookie domain
// regardless.
export function crossSubdomainCookieDomain() {
  if (!isProd) return undefined;
  try {
    const hostname = new URL(process.env.APP_URL || "").hostname;
    return hostname && hostname !== "localhost" ? `.${hostname}` : undefined;
  } catch {
    return undefined;
  }
}

// NOTE: Express's res.cookie() `maxAge` is in MILLISECONDS, unlike the
// original Next.js NextResponse cookie API this was ported from, which uses
// SECONDS — the values below are deliberately *1000 versus the source to
// preserve the exact same real expiry (15 minutes / 30 days), not a typo.

// `domain` is only ever passed by the Google OAuth callback (see routes/auth.js)
// — that's the one path where the response setting this cookie can be on a
// different subdomain than the app the browser ends up on (Google's redirect
// always lands on APP_URL, but the login may have started from the admin
// panel's own subdomain). Every other caller is a same-origin fetch/XHR from
// whichever app the user is already on, so a host-only cookie is correct and
// deliberately left as the default there.
export function setAccessCookie(res, token, { domain } = {}) {
  res.cookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    domain,
    maxAge: 15 * 60 * 1000, // 15 minutes, mirrors the JWT's own expiry
  });
}

export function setRefreshCookie(res, token, { rememberMe, domain } = {}) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "strict",
    path: "/api/auth",
    domain,
    // Omitting maxAge for non-"remember me" logins makes it a session
    // cookie that clears when the browser closes; the Session document's
    // own expiresAt is the durable backstop either way.
    ...(rememberMe ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {}),
  });
}

export function clearAuthCookies(res) {
  // The browser only ever reports a cookie's name/value back to the server,
  // never the Domain it was actually stored under, so a logout call has no
  // way to know whether this session's cookie is the host-only or the
  // cross-subdomain variant. Clearing both is the only reliable way to be
  // sure — clearing one that was never set is a harmless no-op.
  const domain = crossSubdomainCookieDomain();
  res.clearCookie(ACCESS_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  if (domain) {
    res.clearCookie(ACCESS_COOKIE, { path: "/", domain });
    res.clearCookie(REFRESH_COOKIE, { path: "/api/auth", domain });
  }
}
