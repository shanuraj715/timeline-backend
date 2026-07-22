// CSRF defense for a same-origin, cookie-authenticated app: cookies are
// exclusively SameSite=Lax/Strict (blocks cross-site sends outright for the
// browsers we support), and on top of that every mutating request must carry
// a custom header a bare cross-origin <form> submission cannot attach
// without triggering a CORS preflight, plus a matching Origin/Referer.
// Deliberately simpler than double-submit cookie tokens, which would be
// redundant given the cookie settings already in place.
//
// APP_URL/ADMIN_APP_URL must be each frontend's own public origin (not this
// backend's own) — both proxy /api/* here (Next.js rewrites for the main
// app, a Vite dev-server proxy for the admin app), which forwards the
// browser's real Origin/Referer headers through unchanged, so this check
// keeps working exactly as it did when everything was one Next.js project.

import { isMobileClient } from "./platform.js";

const REQUIRED_HEADER = "x-requested-with";
const REQUIRED_HEADER_VALUE = "timeline-app";

function getAllowedOrigins() {
  return [process.env.APP_URL || "http://localhost:3000", process.env.ADMIN_APP_URL || "http://localhost:5174"];
}

export function verifyCsrf(req) {
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;

  // CSRF exploits a browser's *ambient* cookie-sending behavior — a
  // cross-site page can make the browser attach cookies to a request
  // without the victim's own code ever touching them. A Bearer token (the
  // mobile app) has no such ambient channel: it must be deliberately read
  // from secure storage and attached by the client's own code, so none of
  // the Origin/Referer/header checks below are meaningful for it. Only the
  // header's *presence* is checked here, not its validity — a forged or
  // expired bearer token still fails authentication downstream in
  // getCurrentUser, exactly like any other bad credential would.
  if (req.headers.authorization?.startsWith("Bearer ")) return true;

  // Login/register/forgot-password/etc. run BEFORE the mobile app has a
  // bearer token at all, so the check above doesn't cover them — but the
  // same reasoning that protects X-Requested-With below applies here too:
  // there's no `cors()` middleware in this app approving any origin for a
  // custom header, so a forged cross-site request can't get a browser to
  // attach X-Client-Platform either (it'd trigger a preflight this server
  // never approves, and the browser would refuse to send the real
  // request). This only skips the CSRF check itself — a wrong password or
  // invalid token still fails normally downstream.
  if (isMobileClient(req)) return true;

  const header = req.headers[REQUIRED_HEADER];
  if (header !== REQUIRED_HEADER_VALUE) return false;

  const allowed = getAllowedOrigins();
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Every modern browser attaches an Origin header to same-origin fetch/XHR
  // requests for "unsafe" methods, not just cross-origin ones — Origin
  // being present is the normal case, not an edge case. A request with
  // neither Origin nor Referer is what a same-origin browser client would
  // never actually send, so treating that as passing (relying on the custom
  // header alone) was the one gap in an otherwise origin-bound check: a
  // non-browser client, or a proxy/webview that strips both headers, could
  // walk straight through it. Reject outright instead.
  if (!origin && !referer) return false;

  if (origin && !allowed.includes(origin)) return false;
  if (!origin && referer && !allowed.some((a) => referer.startsWith(a))) return false;

  return true;
}
