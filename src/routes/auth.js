import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import { loginSchema, registerSchema, changePasswordSchema } from "../lib/validation/auth.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { verifyPassword, hashPassword } from "../lib/auth/password.js";
import { signAccessToken } from "../lib/auth/jwt.js";
import {
  createSession,
  rotateRefreshToken,
  revokeSessionByToken,
  revokeAllSessionsForUser,
  listActiveSessions,
  hashToken,
} from "../lib/auth/session.js";
import { setAccessCookie, setRefreshCookie, clearAuthCookies, REFRESH_COOKIE } from "../lib/auth/cookies.js";
import { describeDevice } from "../lib/auth/device.js";
import { rateLimit } from "../lib/auth/rateLimit.js";
import { recordFailedLogin, recordSuccessfulLogin, lockoutMessage } from "../lib/auth/lockout.js";
import { logSecurityEvent } from "../lib/logger.js";
import { getCurrentUser, unauthorized, notFound, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFeatureEnabled } from "../lib/featureFlags.js";

export const authRouter = Router();

// A precomputed bcrypt hash of a random value, compared against when the
// email doesn't exist, so "unknown email" and "wrong password" take the
// same amount of time and don't leak which case occurred via a timing side channel.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeOoWQEG8h0VZ0N7X2v6HqF3v8m8V8m8V8";

function requestIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
}

authRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);
    res.json({ user: user.toSafeJSON() });
  })
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const ip = requestIp(req);
    const userAgent = req.headers["user-agent"] || "";

    const { allowed } = rateLimit(`login:${ip}`, { limit: 30, windowMs: 15 * 60 * 1000 });
    if (!allowed) {
      return res.status(429).json({
        error: "Too many login attempts from this network. Please try again later.",
        code: "RATE_LIMITED",
      });
    }

    const data = parseJson(req, res, loginSchema);
    if (!data) return;

    try {
      await connectDB();
      const user = await User.findOne({ email: data.email });

      if (!user) {
        await verifyPassword(data.password, DUMMY_HASH);
        await logSecurityEvent({
          action: "login_failed",
          ip,
          userAgent,
          metadata: { email: data.email, reason: "no_such_user" },
        });
        return res.status(401).json({ error: "Invalid email or password", code: "INVALID_CREDENTIALS" });
      }

      if (user.isLocked()) {
        await logSecurityEvent({ userId: user._id, action: "login_blocked_locked", ip, userAgent });
        return res
          .status(423)
          .json({ error: lockoutMessage(user), code: "ACCOUNT_LOCKED", lockUntil: user.lockUntil });
      }

      const validPassword = await verifyPassword(data.password, user.passwordHash);
      if (!validPassword) {
        await recordFailedLogin(user);
        await logSecurityEvent({
          userId: user._id,
          action: "login_failed",
          ip,
          userAgent,
          metadata: { failedLoginAttempts: user.failedLoginAttempts, locked: user.isLocked() },
        });

        if (user.isLocked()) {
          return res
            .status(423)
            .json({ error: lockoutMessage(user), code: "ACCOUNT_LOCKED", lockUntil: user.lockUntil });
        }
        return res.status(401).json({ error: "Invalid email or password", code: "INVALID_CREDENTIALS" });
      }

      await recordSuccessfulLogin(user);

      const { token: refreshToken } = await createSession({
        userId: user._id,
        device: describeDevice(userAgent),
        userAgent,
        ip,
        rememberMe: Boolean(data.rememberMe),
      });
      const accessToken = await signAccessToken({ userId: user._id, role: user.role });

      await logSecurityEvent({ userId: user._id, action: "login_success", ip, userAgent });

      setAccessCookie(res, accessToken);
      setRefreshCookie(res, refreshToken, { rememberMe: Boolean(data.rememberMe) });
      res.json({ user: user.toSafeJSON() });
    } catch (err) {
      serverError(res, err, "Failed to log in");
    }
  })
);

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    await connectDB();
    if (!(await isFeatureEnabled("registration_enabled"))) {
      return res.status(403).json({ error: "New registrations are temporarily disabled", code: "FEATURE_DISABLED" });
    }

    const ip = requestIp(req);
    const userAgent = req.headers["user-agent"] || "";

    const { allowed } = rateLimit(`register:${ip}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!allowed) return badRequest(res, "Too many registration attempts. Please try again later.");

    const data = parseJson(req, res, registerSchema);
    if (!data) return;

    try {
      await connectDB();

      const existing = await User.findOne({ email: data.email });
      if (existing) {
        return badRequest(res, "An account with this email already exists");
      }

      const passwordHash = await hashPassword(data.password);
      const isBootstrapSuperAdmin =
        process.env.SUPERADMIN_EMAIL && data.email === process.env.SUPERADMIN_EMAIL.toLowerCase();

      const user = await User.create({
        name: data.name,
        email: data.email,
        passwordHash,
        role: isBootstrapSuperAdmin ? "superadmin" : "user",
        lastLoginAt: new Date(),
      });

      const { token: refreshToken } = await createSession({
        userId: user._id,
        device: describeDevice(userAgent),
        userAgent,
        ip,
        rememberMe: true,
      });
      const accessToken = await signAccessToken({ userId: user._id, role: user.role });

      await logSecurityEvent({ userId: user._id, action: "register", ip, userAgent });

      setAccessCookie(res, accessToken);
      setRefreshCookie(res, refreshToken, { rememberMe: true });
      res.status(201).json({ user: user.toSafeJSON() });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "An account with this email already exists");
      serverError(res, err, "Failed to register");
    }
  })
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    await connectDB();

    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) return unauthorized(res, "No active session");

    const ip = requestIp(req);

    const result = await rotateRefreshToken(refreshToken);

    if (!result) {
      clearAuthCookies(res);
      return unauthorized(res, "Session expired, please log in again");
    }

    if (result.reused) {
      await logSecurityEvent({
        userId: result.userId,
        action: "refresh_token_reuse_detected",
        ip,
        metadata: { note: "All sessions revoked as a precaution." },
      });
      clearAuthCookies(res);
      return unauthorized(res, "Session invalidated for your security, please log in again");
    }

    const user = await User.findById(result.session.userId);
    if (!user) {
      clearAuthCookies(res);
      return unauthorized(res, "Account no longer exists");
    }

    const accessToken = await signAccessToken({ userId: user._id, role: user.role });

    setAccessCookie(res, accessToken);
    setRefreshCookie(res, result.token, { rememberMe: result.session.rememberMe });
    res.json({ ok: true });
  })
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    await connectDB();
    // The original gracefully falls back to {} on an unparseable JSON body
    // rather than 400ing — this route's own req.body may be `{}` already
    // (express.json() does that for an empty/missing body), but stays
    // deliberately permissive here rather than relying on the global
    // malformed-JSON error middleware, matching that fallback intent.
    const body = req.body || {};
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    const user = await getCurrentUser(req);
    const ip = clientIp(req);

    if (body?.everywhere && user) {
      await revokeAllSessionsForUser(user._id, "logout_everywhere");
    } else if (refreshToken) {
      await revokeSessionByToken(refreshToken);
    }

    if (user) {
      await logSecurityEvent({
        userId: user._id,
        action: body?.everywhere ? "logout_everywhere" : "logout",
        ip,
      });
    }

    clearAuthCookies(res);
    res.json({ ok: true });
  })
);

authRouter.post(
  "/change-password",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const data = parseJson(req, res, changePasswordSchema);
    if (!data) return;

    try {
      await connectDB();
      const ip = clientIp(req);

      const valid = await verifyPassword(data.currentPassword, user.passwordHash);
      if (!valid) {
        await logSecurityEvent({ userId: user._id, action: "change_password_failed", ip });
        return badRequest(res, "Current password is incorrect");
      }

      user.passwordHash = await hashPassword(data.newPassword);
      user.passwordChangedAt = new Date();
      await user.save();

      await revokeAllSessionsForUser(user._id, "password_changed");
      await logSecurityEvent({ userId: user._id, action: "change_password_success", ip });

      clearAuthCookies(res);
      res.json({ ok: true, message: "Password changed. Please log in again on all devices." });
    } catch (err) {
      serverError(res, err, "Failed to change password");
    }
  })
);

authRouter.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const currentToken = req.cookies?.[REFRESH_COOKIE];
    const currentHash = currentToken ? hashToken(currentToken) : null;

    const sessions = await listActiveSessions(user._id);

    res.json({
      sessions: sessions.map((s) => ({
        id: s._id.toString(),
        device: s.device,
        ip: s.ip,
        rememberMe: s.rememberMe,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
        isCurrent: s.refreshTokenHash === currentHash,
      })),
    });
  })
);

authRouter.delete(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const { id } = req.params;

    const session = await Session.findOne({ _id: id, userId: user._id });
    if (!session) return notFound(res, "Session not found");

    session.revoked = true;
    session.revokedReason = "user_revoked";
    await session.save();

    await logSecurityEvent({
      userId: user._id,
      action: "session_revoked",
      ip: clientIp(req),
      metadata: { sessionId: id },
    });

    res.json({ ok: true });
  })
);
