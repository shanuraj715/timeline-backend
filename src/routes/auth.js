import crypto from "crypto";
import { Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { connectDB } from "../lib/db/connect.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import PasswordResetOtp from "../models/PasswordResetOtp.js";
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../lib/validation/auth.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
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
import { verifyRecaptcha } from "../lib/auth/recaptcha.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFeatureEnabled } from "../lib/featureFlags.js";
import { sendTemplatedEmail } from "../lib/email/send.js";
import { getPlatformSettings } from "../lib/platformSettings.js";
import { getActiveGoogleOAuthClient } from "../lib/googleOAuthSettings.js";

export const authRouter = Router();

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes, matches otp_expiry_minutes below
const OTP_MAX_ATTEMPTS = 5;

const GOOGLE_STATE_COOKIE = "tl_google_state";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Fetched lazily and cached across requests by jose itself (this only
// needs to be created once per process, not per request).
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function googleRedirectUri() {
  return `${process.env.APP_URL || "http://localhost:3000"}/api/auth/google/callback`;
}

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

    const recaptcha = await verifyRecaptcha(data.recaptchaToken);
    if (!recaptcha.ok) {
      await logSecurityEvent({ action: "login_blocked_recaptcha", ip, userAgent, metadata: { reason: recaptcha.reason } });
      return badRequest(res, "We couldn't verify you're not a robot. Please try again.");
    }

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

      // A Google-only account (see /google/callback) has no local password
      // to check against — bcrypt.compare against a null hash isn't a
      // meaningful "wrong password," it's a different account type entirely.
      if (!user.passwordHash) {
        await logSecurityEvent({ userId: user._id, action: "login_failed", ip, userAgent, metadata: { reason: "google_only_account" } });
        return res.status(401).json({
          error: "This account signs in with Google. Use the \"Continue with Google\" button instead.",
          code: "GOOGLE_ONLY_ACCOUNT",
        });
      }

      const validPassword = await verifyPassword(data.password, user.passwordHash);
      if (!validPassword) {
        const { justLocked } = await recordFailedLogin(user);
        await logSecurityEvent({
          userId: user._id,
          action: "login_failed",
          ip,
          userAgent,
          metadata: { failedLoginAttempts: user.failedLoginAttempts, locked: user.isLocked() },
        });

        if (user.isLocked()) {
          // Only on the attempt that just crossed a threshold — not on
          // every subsequent failed attempt while still locked.
          if (justLocked) {
            const minutesLeft = Math.ceil((user.lockUntil.getTime() - Date.now()) / 60000);
            const lockDuration = minutesLeft >= 60 ? `${Math.ceil(minutesLeft / 60)} hours` : `${minutesLeft} minutes`;
            sendTemplatedEmail("account_locked", { user, vars: { lock_duration: lockDuration } });
          }
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

    const recaptcha = await verifyRecaptcha(data.recaptchaToken);
    if (!recaptcha.ok) {
      await logSecurityEvent({ action: "register_blocked_recaptcha", ip, userAgent, metadata: { reason: recaptcha.reason } });
      return badRequest(res, "We couldn't verify you're not a robot. Please try again.");
    }

    try {
      await connectDB();

      const existing = await User.findOne({ email: data.email });
      if (existing) {
        return badRequest(res, "An account with this email already exists");
      }

      const passwordHash = await hashPassword(data.password);
      const isBootstrapSuperAdmin =
        process.env.SUPERADMIN_EMAIL && data.email === process.env.SUPERADMIN_EMAIL.toLowerCase();
      const settings = await getPlatformSettings();

      const user = await User.create({
        name: `${data.firstName} ${data.lastName}`,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        passwordHash,
        dob: data.dob,
        gender: data.gender,
        phone: data.phone || null,
        country: data.country || null,
        role: isBootstrapSuperAdmin ? "superadmin" : "user",
        credits: settings.defaultCreditsOnSignup,
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
      sendTemplatedEmail("welcome", { user, vars: { signup_bonus_credits: String(settings.defaultCreditsOnSignup) } });

      setAccessCookie(res, accessToken);
      setRefreshCookie(res, refreshToken, { rememberMe: true });
      res.status(201).json({ user: user.toSafeJSON() });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "An account with this email already exists");
      serverError(res, err, "Failed to register");
    }
  })
);

// Full-page redirects, not fetch/XHR — the browser has to actually leave
// for Google's consent screen and come back, so these can't go through
// apiClient.js's usual JSON-request convention. A real click on <a
// href="/api/auth/google"> (see google-signin-button.jsx on the frontend)
// starts the flow; the callback below finishes it and redirects straight
// into the app, cookies already set — no dedicated frontend callback page
// exists or is needed.
authRouter.get(
  "/google",
  asyncHandler(async (req, res) => {
    await connectDB();
    const client = await getActiveGoogleOAuthClient();
    if (!client) return badRequest(res, "Google sign-in isn't configured");

    // CSRF/replay protection for the redirect round-trip: a random value
    // stashed in a short-lived cookie now, and required to come back
    // unchanged as the `state` query param on the callback.
    const state = crypto.randomBytes(24).toString("base64url");
    res.cookie(GOOGLE_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/auth/google",
      maxAge: 10 * 60 * 1000,
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", googleRedirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    // Always shows Google's account chooser, even with one active session
    // — an explicit choice reads better for a "sign in" button than
    // silently reusing whatever Google account happens to be logged in.
    url.searchParams.set("prompt", "select_account");

    res.redirect(url.toString());
  })
);

// One unified flow for both sign-in and sign-up — Google doesn't
// distinguish the two, so neither does this: find by googleId, else find
// by verified email and link, else create a new account. Same result
// whichever button (login page or register page) the user actually clicked.
authRouter.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    const ip = clientIp(req);
    const userAgent = req.headers["user-agent"] || "";

    function failRedirect(reason) {
      logSecurityEvent({ action: "google_login_failed", ip, userAgent, metadata: { reason } }).catch(() => {});
      res.redirect(`${appUrl}/login?error=google_failed`);
    }

    try {
      await connectDB();
      const client = await getActiveGoogleOAuthClient();
      if (!client) return failRedirect("not_configured");

      const cookieState = req.cookies?.[GOOGLE_STATE_COOKIE];
      res.clearCookie(GOOGLE_STATE_COOKIE, { path: "/api/auth/google" });

      if (req.query.error) return failRedirect("denied_by_user");
      const { code, state } = req.query;
      if (!code || !state || !cookieState || state !== cookieState) return failRedirect("state_mismatch");

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: String(code),
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: googleRedirectUri(),
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) return failRedirect("token_exchange_failed");
      const tokenData = await tokenRes.json();
      if (!tokenData.id_token) return failRedirect("no_id_token");

      // Verifies signature + expiry + issuer + audience against Google's
      // own published keys — this is the actual proof the token really
      // came from Google for *this* client, not just a well-formed JWT.
      const { payload } = await jwtVerify(tokenData.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: client.clientId,
      });

      if (!payload.email_verified) return failRedirect("email_unverified");

      const googleId = payload.sub;
      const email = String(payload.email).toLowerCase();

      let user = await User.findOne({ googleId });
      let isNewAccount = false;

      if (!user) {
        // An existing password account with this same, Google-verified
        // email gets linked rather than duplicated — from then on it can
        // sign in either way.
        user = await User.findOne({ email });
        if (user) {
          user.googleId = googleId;
          if (!user.avatarUrl && payload.picture) user.avatarUrl = payload.picture;
          await user.save();
        }
      }

      if (!user) {
        const settings = await getPlatformSettings();
        const firstName = payload.given_name || String(payload.name || "").split(" ")[0] || "Google";
        const lastName = payload.family_name || String(payload.name || "").split(" ").slice(1).join(" ") || "";
        user = await User.create({
          firstName,
          lastName,
          name: `${firstName} ${lastName}`.trim(),
          email,
          googleId,
          passwordHash: null,
          avatarUrl: payload.picture || null,
          role: "user",
          credits: settings.defaultCreditsOnSignup,
          lastLoginAt: new Date(),
        });
        isNewAccount = true;
        sendTemplatedEmail("welcome", { user, vars: { signup_bonus_credits: String(settings.defaultCreditsOnSignup) } });
      }

      if (user.isLocked()) {
        logSecurityEvent({ userId: user._id, action: "login_blocked_locked", ip, userAgent }).catch(() => {});
        return res.redirect(`${appUrl}/login?error=account_locked`);
      }

      await recordSuccessfulLogin(user);

      const { token: refreshToken } = await createSession({
        userId: user._id,
        device: describeDevice(userAgent),
        userAgent,
        ip,
        rememberMe: true,
      });
      const accessToken = await signAccessToken({ userId: user._id, role: user.role });

      await logSecurityEvent({ userId: user._id, action: isNewAccount ? "google_register" : "google_login", ip, userAgent });

      setAccessCookie(res, accessToken);
      setRefreshCookie(res, refreshToken, { rememberMe: true });
      res.redirect(`${appUrl}/dashboard`);
    } catch (err) {
      console.error("Google OAuth callback failed:", err);
      failRedirect("exception");
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

      // Google-only accounts (see /google/callback) have no local password
      // to change — no "set an initial password" flow exists yet, so this
      // is a clean, explicit rejection rather than bcrypt.compare erroring
      // on a null hash.
      if (!user.passwordHash) {
        return badRequest(res, "This account signs in with Google and has no password to change.");
      }

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

authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const ip = requestIp(req);
    // Keyed by IP only (not by the submitted email) — keying by email too
    // would let an attacker learn which addresses are registered by
    // watching which ones get rate-limited differently.
    const { allowed } = rateLimit(`forgot-password:${ip}`, { limit: 5, windowMs: 60 * 60 * 1000 });
    if (!allowed) return badRequest(res, "Too many requests. Please try again later.");

    const data = parseJson(req, res, forgotPasswordSchema);
    if (!data) return;

    // Always the same response regardless of whether the account exists —
    // an account-enumeration side channel here would let an attacker probe
    // which emails are registered just by watching the response.
    const GENERIC_MESSAGE = "If an account exists for that email, we've sent a reset code.";

    try {
      await connectDB();
      const user = await User.findOne({ email: data.email });
      if (!user) return res.json({ ok: true, message: GENERIC_MESSAGE });

      const otp = crypto.randomInt(100000, 1000000).toString();
      const otpHash = await hashPassword(otp);

      await PasswordResetOtp.deleteMany({ userId: user._id });
      await PasswordResetOtp.create({
        userId: user._id,
        otpHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      });

      await logSecurityEvent({ userId: user._id, action: "password_reset_requested", ip: clientIp(req) });
      await sendTemplatedEmail("password_reset_otp", {
        user,
        vars: { otp_code: otp, otp_expiry_minutes: String(OTP_TTL_MS / 60000) },
      });

      res.json({ ok: true, message: GENERIC_MESSAGE });
    } catch (err) {
      serverError(res, err, "Failed to process request");
    }
  })
);

authRouter.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const ip = requestIp(req);
    const { allowed } = rateLimit(`reset-password:${ip}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!allowed) return badRequest(res, "Too many requests. Please try again later.");

    const data = parseJson(req, res, resetPasswordSchema);
    if (!data) return;

    try {
      await connectDB();
      const user = await User.findOne({ email: data.email });
      if (!user) return badRequest(res, "Invalid or expired code");

      const otpDoc = await PasswordResetOtp.findOne({ userId: user._id, consumedAt: null });
      if (!otpDoc) return badRequest(res, "Invalid or expired code");

      // Expiry is also enforced by a Mongo TTL index on this collection, but
      // TTL cleanup runs on a periodic background sweep, not instantly at
      // the exact expiry moment — this closes the gap where a code could
      // still be accepted briefly after it should already be dead.
      if (otpDoc.expiresAt < new Date()) {
        await otpDoc.deleteOne();
        return badRequest(res, "Invalid or expired code");
      }

      if (otpDoc.attempts >= OTP_MAX_ATTEMPTS) {
        await otpDoc.deleteOne();
        return badRequest(res, "Too many incorrect attempts. Please request a new code.");
      }

      const valid = await verifyPassword(data.otp, otpDoc.otpHash);
      if (!valid) {
        otpDoc.attempts += 1;
        await otpDoc.save();
        return badRequest(res, "Invalid or expired code");
      }

      user.passwordHash = await hashPassword(data.newPassword);
      user.passwordChangedAt = new Date();
      await user.save();

      await otpDoc.deleteOne();
      await revokeAllSessionsForUser(user._id, "password_reset");
      await logSecurityEvent({ userId: user._id, action: "password_reset_success", ip: clientIp(req) });

      clearAuthCookies(res);
      res.json({ ok: true, message: "Password reset. Please log in with your new password." });
    } catch (err) {
      serverError(res, err, "Failed to reset password");
    }
  })
);

authRouter.post(
  "/delete-account",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const data = parseJson(req, res, deleteAccountSchema);
    if (!data) return;

    try {
      await connectDB();

      // A Google-only account has no password to confirm with — their
      // active session already proves identity, so there's nothing to
      // verify data.password against (unlike a password account, where
      // re-entering it is the confirmation step).
      if (user.passwordHash) {
        const valid = await verifyPassword(data.password, user.passwordHash);
        if (!valid) return badRequest(res, "Password is incorrect");
      }

      // Deleting an account that still owns timelines would orphan them for
      // every other member — require the owner to transfer ownership or
      // delete those timelines first rather than silently cascading.
      const ownedCount = await Timeline.countDocuments({ ownerId: user._id, deletedAt: null });
      if (ownedCount > 0) {
        return badRequest(
          res,
          `You still own ${ownedCount} timeline${ownedCount === 1 ? "" : "s"}. Transfer ownership or delete ${
            ownedCount === 1 ? "it" : "them"
          } first.`
        );
      }

      const ip = clientIp(req);
      await Membership.deleteMany({ userId: user._id });
      await revokeAllSessionsForUser(user._id, "account_deleted");
      await logSecurityEvent({ userId: user._id, action: "account_deleted", ip });
      await User.deleteOne({ _id: user._id });

      clearAuthCookies(res);
      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to delete account");
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
