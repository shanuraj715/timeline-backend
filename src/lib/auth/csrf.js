// CSRF defense for a same-origin, cookie-authenticated app: cookies are
// exclusively SameSite=Lax/Strict (blocks cross-site sends outright for the
// browsers we support), and on top of that every mutating request must carry
// a custom header a bare cross-origin <form> submission cannot attach
// without triggering a CORS preflight, plus a matching Origin/Referer.
// Deliberately simpler than double-submit cookie tokens, which would be
// redundant given the cookie settings already in place.
//
// APP_URL must be the FRONTEND's public origin (not this backend's own) —
// the frontend proxies /api/* here via Next.js rewrites, which forwards the
// browser's real Origin/Referer headers through unchanged, so this check
// keeps working exactly as it did when everything was one Next.js project.

const REQUIRED_HEADER = "x-requested-with";
const REQUIRED_HEADER_VALUE = "timeline-app";

function getAllowedOrigin() {
  return process.env.APP_URL || "http://localhost:3000";
}

export function verifyCsrf(req) {
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;

  const header = req.headers[REQUIRED_HEADER];
  if (header !== REQUIRED_HEADER_VALUE) return false;

  const origin = req.headers.origin;
  const allowed = getAllowedOrigin();
  if (origin && origin !== allowed) return false;

  if (!origin) {
    const referer = req.headers.referer;
    if (referer && !referer.startsWith(allowed)) return false;
  }

  return true;
}
