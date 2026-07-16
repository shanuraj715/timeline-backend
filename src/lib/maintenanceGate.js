// Mounted app-wide in server.js, ahead of every route. When maintenance
// mode is on, every API call from the main site (FE) gets this same 503 +
// MAINTENANCE_CODE shape instead of reaching its normal handler —
// timeline's apiClient.js/backendClient.js watch for exactly this response
// to switch to the maintenance page.
//
// Maintenance mode is FE-only by design — the admin panel is the one place
// that can ever turn it back off, so it must never be able to lock itself
// out. Traffic from the admin panel is recognized the same way
// lib/auth/csrf.js already distinguishes the two frontends: by Origin (or,
// lacking that, Referer) against ADMIN_APP_URL. This is deliberately
// unconditional on auth state — an earlier version tried to bypass the gate
// only for an already-authenticated superadmin, which meant a superadmin
// whose 15-minute access token simply expired while maintenance mode was
// on got a 503 instead of the normal 401 every other route would give,
// and — since 503 isn't a status apiClient.js's silent-refresh-and-retry
// logic watches for — never got a chance to refresh and try again. Every
// request they made, including the one meant to turn maintenance mode back
// off, kept 503ing. Exempting the admin panel by origin instead of by role
// sidesteps that whole failure mode: it doesn't matter whether the request
// is authenticated, expired, or anonymous, admin-panel traffic is simply
// never subject to this gate.
import { getMaintenanceState } from "./maintenance.js";

const ALWAYS_ALLOWED_PREFIXES = ["/api/auth", "/api/health", "/api/public/maintenance"];

function isAdminPanelOrigin(req) {
  const adminOrigin = process.env.ADMIN_APP_URL || "http://localhost:5174";
  const origin = req.headers.origin;
  if (origin) return origin === adminOrigin;
  const referer = req.headers.referer;
  return Boolean(referer && referer.startsWith(adminOrigin));
}

export function maintenanceGate() {
  return async (req, res, next) => {
    try {
      if (ALWAYS_ALLOWED_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
        return next();
      }
      if (isAdminPanelOrigin(req)) return next();

      const state = await getMaintenanceState();
      if (!state.enabled) return next();

      return res.status(503).json({
        error: state.message || "The site is currently undergoing maintenance. Please check back soon.",
        code: "MAINTENANCE_MODE",
      });
    } catch (err) {
      next(err);
    }
  };
}
