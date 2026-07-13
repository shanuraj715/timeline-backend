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

/** Verifies the access token cookie and loads the current User doc, or null. */
export async function getCurrentUser(req) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return null;

  const claims = await verifyAccessToken(token);
  if (!claims) return null;

  await connectDB();
  const user = await User.findById(claims.userId);
  return user || null;
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

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return (
    (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : null) ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}
