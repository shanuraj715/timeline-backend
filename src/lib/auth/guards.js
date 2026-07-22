// Ported from Next.js route handlers, which read cookies via an ambient
// `cookies()`/`headers()` API and returned NextResponse objects directly.
// Express has no ambient request context, so every function here that used
// to be argument-less now takes `req`/`res` explicitly — the call-site shape
// stays as close to the original as the framework difference allows:
// `if (!user) return unauthorized(res);` reads almost identically to the
// original `if (!user) return unauthorized();`, keeping the route ports in
// later chunks mechanical.
import { connectDB } from "../db/connect.js";
import { verifyAccessToken } from "./jwt.js";
import { ACCESS_COOKIE } from "./cookies.js";
import User from "../../models/User.js";
import Membership from "../../models/Membership.js";
import Timeline from "../../models/Timeline.js";
import { permissions } from "../rbac/permissions.js";
import { getPlatformSettings } from "../platformSettings.js";

/**
 * Verifies the access token and loads the current User doc, or null.
 * Checks the Authorization header first (the mobile app — a bearer token,
 * not a cookie) and falls back to the web's ACCESS_COOKIE. Same JWT
 * (jose, signAccessToken/verifyAccessToken), same 15-minute TTL, same
 * mandatory User lookup either way — a mobile request never touches a
 * different code path than this one function, so every permission helper
 * built on top of it (checkPermission, requirePermission, etc.) needs no
 * changes at all to work for both.
 */
export async function getCurrentUser(req) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const token = bearerToken || req.cookies?.[ACCESS_COOKIE];
  if (!token) return null;

  const claims = await verifyAccessToken(token);
  if (!claims) return null;

  await connectDB();
  const user = await User.findById(claims.userId);
  if (!user) return null;
  // A banned account is treated as unauthenticated everywhere this is
  // called (which is effectively every route) — the ban action also
  // revokes all of that account's sessions, but this is what makes it take
  // effect immediately rather than only once the current access token
  // expires (up to 15 minutes later) or a refresh is attempted.
  if (user.banned) return null;
  return user;
}

export function unauthorized(res, message = "Authentication required") {
  res.status(401).json({ error: message, code: "UNAUTHORIZED" });
}

export function forbidden(res, message = "You do not have permission to do this") {
  res.status(403).json({ error: message, code: "FORBIDDEN" });
}

export function notFound(res, message = "Not found") {
  res.status(404).json({ error: message, code: "NOT_FOUND" });
}

/** Loads the Timeline by slug and the requesting user's membership in it. */
export async function getTimelineAndMembership(slug, userId) {
  await connectDB();
  const timeline = await Timeline.findOne({ slug, deletedAt: null });
  if (!timeline) return { timeline: null, membership: null };

  const membership = await Membership.findOne({
    timelineId: timeline._id,
    userId,
    status: "active",
  });
  return { timeline, membership };
}

/**
 * Resolves whether the current request can VIEW a timeline it has no
 * Membership on — the "Shared" case (a real Membership exists) is handled
 * entirely upstream of this function and never reaches it; this is purely
 * about the "Private"/"Public" visibility layered on top. Only ever used
 * by the small set of read-only routes a viewer needs to render a
 * timeline (GET /:slug, /days, /days/:dayKey, /facets, /media,
 * /media/search, /theme) — every mutating route keeps requiring a real
 * Membership at sufficient role, completely untouched by this.
 *
 * `role: "guest"` deliberately isn't in lib/rbac/permissions.js's ROLES
 * list — roleAtLeast() returns false for any unrecognized role, so a
 * guest can never pass a checkPermission() call by construction, not by
 * convention. Callers on the read routes above still need to branch on
 * `role === "guest"` explicitly where they'd otherwise expose
 * member-only data (e.g. other members' identities).
 *
 * @returns {Promise<{allowed: boolean, role: string|"guest"|null}>}
 */
export async function resolveTimelineViewAccess(timeline, membership, user) {
  if (membership) return { allowed: true, role: membership.role };

  if (timeline.visibility === "private") return { allowed: false, role: null };
  if (timeline.visibility === "shared") return { allowed: false, role: null };

  // visibility === "public" from here on.
  if (user) return { allowed: true, role: "guest" };

  // Fully anonymous — only allowed if both the platform-wide switch and
  // this timeline's own opt-in are on.
  const settings = await getPlatformSettings();
  if (settings.allowGuestViewing && timeline.settings?.guestViewEnabled) {
    return { allowed: true, role: "guest" };
  }
  return { allowed: false, role: null };
}

/**
 * checkPermission("uploadMedia", membership, res) checks the acting user's
 * role in the given timeline against lib/rbac/permissions.js. Writes a 403
 * response and returns false when disallowed; returns true when authorized.
 * Route handlers use it as `if (!checkPermission(...)) return;`.
 */
export function checkPermission(permissionName, membership, res) {
  const check = permissions[permissionName];
  if (!check) throw new Error(`Unknown permission: ${permissionName}`);
  if (!membership || !check(membership.role)) {
    forbidden(res);
    return false;
  }
  return true;
}

/**
 * Requires the platform superadmin role, verified fresh from the DB (never
 * trust the JWT claim alone for authorization). Writes the appropriate
 * error response itself and returns null when disallowed, otherwise
 * returns the User doc. Route handlers use it as
 * `const user = await requireSuperAdmin(req, res); if (!user) return;`.
 */
export async function requireSuperAdmin(req, res) {
  const user = await getCurrentUser(req);
  if (!user) {
    unauthorized(res);
    return null;
  }
  if (user.role !== "superadmin") {
    forbidden(res, "Superadmin access required");
    return null;
  }
  return user;
}

/**
 * Requires the current account to hold a specific admin permission key (see
 * lib/permissions.js), verified fresh from the DB same as requireSuperAdmin.
 * A superadmin passes every check unconditionally — it implicitly holds
 * every permission and doesn't use the `permissions` array at all. Route
 * handlers use it as
 * `const admin = await requirePermission(req, res, "commerce.currencies"); if (!admin) return;`.
 */
export async function requirePermission(req, res, key) {
  const user = await getCurrentUser(req);
  if (!user) {
    unauthorized(res);
    return null;
  }
  if (user.role === "superadmin") return user;
  if (user.role === "admin" && user.permissions.includes(key)) return user;
  forbidden(res, "You do not have permission to do this");
  return null;
}

/**
 * Same contract as requirePermission, but passes if the account holds ANY
 * of the given keys — for routes shared by more than one admin-panel tab
 * (e.g. the CMS media upload endpoint, used by both the Pages rich-text
 * editor and the Homepage image fields).
 */
export async function requireAnyPermission(req, res, keys) {
  const user = await getCurrentUser(req);
  if (!user) {
    unauthorized(res);
    return null;
  }
  if (user.role === "superadmin") return user;
  if (user.role === "admin" && keys.some((key) => user.permissions.includes(key))) return user;
  forbidden(res, "You do not have permission to do this");
  return null;
}

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return (
    (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : null) ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}
