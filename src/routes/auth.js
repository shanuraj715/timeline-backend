import crypto from "crypto";
import { Router } from "express";
import multer from "multer";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { connectDB } from "../lib/db/connect.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import PasswordResetOtp from "../models/PasswordResetOtp.js";
import {
  loginSchema,
  registerSchema,
  updateProfileSchema,
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../lib/validation/auth.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
import Order from "../models/Order.js";
import ActivityLog from "../models/ActivityLog.js";
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
import {
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
  crossSubdomainCookieDomain,
  REFRESH_COOKIE,
} from "../lib/auth/cookies.js";
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
import { getStorage } from "../lib/storage/index.js";
import { validateMediaFile } from "../lib/media/fileValidation.js";
import { processAvatarImage, AvatarNotSquareError } from "../lib/media/avatar.js";

export const authRouter = Router();

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes, matches otp_expiry_minutes below
const OTP_MAX_ATTEMPTS = 5;
const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Shared by /register and /resend-verification. Never awaited by its
// callers on the hot path (registration shouldn't block on outbound email
// delivery) — same fire-and-forget convention as every other
// sendTemplatedEmail call site in this file.
async function issueEmailVerification(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  user.emailVerificationTokenHash = hashToken(token);
  user.emailVerificationExpiresAt = new Date(Date.now() + VERIFY_EMAIL_TTL_MS);
  await user.save();

  const verifyUrl = `${process.env.APP_URL || ""}/verify-email/${token}`;
  sendTemplatedEmail("verify_email", {
    user,
    vars: { verify_url: verifyUrl, verify_expiry_hours: String(VERIFY_EMAIL_TTL_MS / 3600000) },
  });
}

const GOOGLE_STATE_COOKIE = "tl_google_state";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Fetched lazily and cached across requests by jose itself (this only
// needs to be created once per process, not per request).
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function googleRedirectUri() {
  // Always the main app's domain, registered as-is in Google's console —
  // deliberately NOT branched per `app` below. Google only needs this
  // callback URL to match something it has on file; it's this handler's own
  // response that decides which app's origin the browser ultimately lands
  // back on, so the admin panel's "Sign in with Google" button reuses this
  // exact same redirect_uri instead of requiring a second one to be
  // registered with Google for the admin domain too.
  return `${process.env.APP_URL || "http://localhost:3000"}/api/auth/google/callback`;
}

// The state cookie (and, on success, the session cookies below) are set on
// whichever origin started the flow (main app or admin panel) but the
// callback above always lands on the main app's origin (googleRedirectUri()
// is never branched) — so on a real deployment, where admin lives on its own
// subdomain, a host-only cookie set during an admin-initiated login would
// never make it back to admin.mytimelyne.com. crossSubdomainCookieDomain()
// scopes them to the shared parent domain instead so they're readable from
// both; see its own comment in cookies.js.

// "app" travels through Google's own `state` round-trip (appended after the
// random CSRF value, verified byte-for-byte against the cookie same as
// before) so the callback below knows whether this login started from the
// main app's login/register page or the admin panel's — they need
// different outcomes: the main app can silently create a new account,
// the admin panel must never create an account and must reject anything
// that isn't already role "admin"/"superadmin".
const GOOGLE_OAUTH_APPS = ["main", "admin"];

function parseGoogleState(state) {
  const i = state.lastIndexOf(".");
  const app = i === -1 ? "main" : state.slice(i + 1);
  return GOOGLE_OAUTH_APPS.includes(app) ? app : "main";
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

      if (user.banned) {
        await logSecurityEvent({ userId: user._id, action: "login_blocked_banned", ip, userAgent });
        return res.status(403).json({ error: "This account has been suspended.", code: "ACCOUNT_BANNED" });
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
      // Doesn't block/fail registration if it errors — this is defense
      // against a claimed-but-unverified email, not a hard requirement to
      // use the app (see the User model comment on emailVerified).
      issueEmailVerification(user).catch(() => {});

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
    // unchanged as the `state` query param on the callback. The `.app`
    // suffix rides along on the exact same value, so it's implicitly
    // covered by the same cookie-equality check — no separate cookie
    // needed just to carry which app started this.
    const app = GOOGLE_OAUTH_APPS.includes(req.query.app) ? req.query.app : "main";
    const state = `${crypto.randomBytes(24).toString("base64url")}.${app}`;
    res.cookie(GOOGLE_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/auth/google",
      domain: crossSubdomainCookieDomain(),
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
    const adminAppUrl = process.env.ADMIN_APP_URL || "http://localhost:5174";
    const ip = clientIp(req);
    const userAgent = req.headers["user-agent"] || "";

    // `app` is resolved from `state` below (the only tamper-proof carrier
    // available mid-flow — it's verified byte-for-byte against the state
    // cookie first) and defaults to "main" until then, so an early failure
    // (bad state, Google-side error) still has somewhere sane to send the
    // browser back to.
    let app = "main";
    function failRedirect(reason) {
      logSecurityEvent({ action: "google_login_failed", ip, userAgent, metadata: { reason, app } }).catch(() => {});
      const base = app === "admin" ? adminAppUrl : appUrl;
      res.redirect(`${base}/login?error=google_failed`);
    }

    try {
      await connectDB();
      const client = await getActiveGoogleOAuthClient();
      if (!client) return failRedirect("not_configured");

      const cookieState = req.cookies?.[GOOGLE_STATE_COOKIE];
      res.clearCookie(GOOGLE_STATE_COOKIE, { path: "/api/auth/google", domain: crossSubdomainCookieDomain() });

      if (req.query.error) return failRedirect("denied_by_user");
      const { code, state } = req.query;
      if (!code || !state || !cookieState || state !== cookieState) return failRedirect("state_mismatch");
      app = parseGoogleState(state);
      const redirectAppUrl = app === "admin" ? adminAppUrl : appUrl;

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
        // sign in either way. Applies to admin accounts too: a superadmin
        // or limited admin created the normal way (password, or granted via
        // the admin-accounts API) can link and start using Google sign-in
        // the first time they use it, same as any other account.
        user = await User.findOne({ email });
        if (user) {
          user.googleId = googleId;
          if (!user.avatarUrl && payload.picture) user.avatarUrl = payload.picture;
          await user.save();
        }
      }

      // The admin panel never creates an account through this flow — Google
      // sign-in there only works for an email that's *already* an
      // admin/superadmin. Letting it auto-create (like the main app does)
      // would mean anyone with a Google account could self-provision an
      // account that then just fails the role check below, which is a
      // pointless account-creation side effect at best and a confusing
      // enumeration surface at worst; failing before creating avoids both.
      if (!user && app === "admin") return failRedirect("no_admin_account");

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
          // payload.email_verified was already required (checked above) to
          // reach this point — Google has already done the proof-of-
          // ownership work /register's token flow exists to do.
          emailVerified: true,
          credits: settings.defaultCreditsOnSignup,
          lastLoginAt: new Date(),
        });
        isNewAccount = true;
        sendTemplatedEmail("welcome", { user, vars: { signup_bonus_credits: String(settings.defaultCreditsOnSignup) } });
      }

      // Mirrors AuthContext.jsx's own client-side check on the admin panel
      // (defense in depth, not the only gate) — a "user"-role account
      // (or one demoted since it last linked Google) never gets an admin
      // session, even if the email/Google identity itself checks out fine.
      if (app === "admin" && user.role !== "admin" && user.role !== "superadmin") {
        return failRedirect("not_admin");
      }

      if (user.banned) {
        logSecurityEvent({ userId: user._id, action: "login_blocked_banned", ip, userAgent, metadata: { app } }).catch(() => {});
        return res.redirect(`${redirectAppUrl}/login?error=account_banned`);
      }

      if (user.isLocked()) {
        logSecurityEvent({ userId: user._id, action: "login_blocked_locked", ip, userAgent, metadata: { app } }).catch(() => {});
        return res.redirect(`${redirectAppUrl}/login?error=account_locked`);
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

      await logSecurityEvent({
        userId: user._id,
        action: isNewAccount ? "google_register" : "google_login",
        ip,
        userAgent,
        metadata: { app },
      });

      setAccessCookie(res, accessToken);
      setRefreshCookie(res, refreshToken, { rememberMe: true });
      res.redirect(app === "admin" ? redirectAppUrl : `${redirectAppUrl}/dashboard`);
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

// Also used for onboarding (fills in dob/gender/phone/country a Google
// signup can't collect during /google/callback, since Google's profile
// scope doesn't carry any of it) and for the dashboard's "Manage profile"
// page's general field edits (name/dob/gender/phone/country) — every field
// is optional here (updateProfileSchema) so a request only has to send what
// it's actually changing; the onboarding page's own form is what actually
// requires dob/gender before letting the user submit.
authRouter.patch(
  "/profile",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const data = parseJson(req, res, updateProfileSchema);
    if (!data) return;

    await connectDB();
    if (data.firstName !== undefined) user.firstName = data.firstName;
    if (data.lastName !== undefined) user.lastName = data.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      user.name = `${data.firstName ?? user.firstName ?? ""} ${data.lastName ?? user.lastName ?? ""}`.trim();
    }
    if (data.dob !== undefined) user.dob = data.dob;
    if (data.gender !== undefined) user.gender = data.gender;
    if (data.phone !== undefined) user.phone = data.phone || null;
    if (data.country !== undefined) user.country = data.country || null;
    await user.save();

    res.json({ user: user.toSafeJSON() });
  })
);

// Square-only by design (see lib/media/avatar.js's AvatarNotSquareError) —
// rejected rather than auto-cropped, so the user picks/creates an image
// they're actually happy with instead of the crop silently cutting off
// part of it. Always re-encoded to webp at a fixed size and stored under a
// fixed per-user key, so a re-upload just overwrites in place.
authRouter.post(
  "/avatar",
  avatarUpload.single("avatar"),
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    if (!req.file) return badRequest(res, "No image file was provided");

    const validation = await validateMediaFile(req.file.buffer);
    if (!validation.valid || validation.type !== "image") {
      return badRequest(res, validation.reason || "File must be a valid image");
    }

    let processed;
    try {
      processed = await processAvatarImage(req.file.buffer);
    } catch (err) {
      if (err instanceof AvatarNotSquareError) {
        return badRequest(res, "Please upload a square image (equal width and height)");
      }
      throw err;
    }

    await connectDB();
    const avatarKey = `avatars/${user._id}/avatar.webp`;
    const storage = await getStorage();
    await storage.write(avatarKey, processed.avatarBuffer);

    user.avatarKey = avatarKey;
    user.avatarVersion = (user.avatarVersion || 0) + 1;
    user.avatarUrl = `/api/auth/avatar/${user._id}?v=${user.avatarVersion}`;
    await user.save();

    res.json({ user: user.toSafeJSON() });
  })
);

authRouter.delete(
  "/avatar",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    if (user.avatarKey) {
      const storage = await getStorage();
      await storage.remove(user.avatarKey).catch(() => {});
      user.avatarKey = null;
    }
    user.avatarUrl = null;
    await user.save();

    res.json({ user: user.toSafeJSON() });
  })
);

// Public, unauthenticated — an avatar has to be visible to other timeline
// members (see routes/timelines.js's `populate(... "name avatarUrl")`
// call sites), not just its owner, same reasoning as routes/themes.js's
// theme-image serve route. Only ever returns a self-uploaded avatar; a
// Google-sourced one is already a full external URL (see the model
// comment) and never reaches this route at all.
authRouter.get(
  "/avatar/:userId",
  asyncHandler(async (req, res) => {
    await connectDB();
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser || !targetUser.avatarKey) return notFound(res, "Avatar not found");

    const storage = await getStorage();
    if (!(await storage.exists(targetUser.avatarKey))) return notFound(res, "Avatar not found in storage");

    const { stream, size } = await storage.createReadStream(targetUser.avatarKey, null);
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": String(size),
      "X-Content-Type-Options": "nosniff",
    });
    stream.pipe(res);
  })
);

// GET (no CSRF — safe/idempotent, same convention as invitations.js's
// GET /:token) lets the frontend's /verify-email/:token page show what it's
// about to do before the user commits; POST (CSRF-protected) is the actual
// mutation. Neither requires being logged in — the token itself, mailed
// only to the address being verified, is the proof of ownership, not the
// browser's session cookie (matching how /reset-password's OTP-based
// identity works, not the cookie-based identity change-password uses).
authRouter.get(
  "/verify-email/:token",
  asyncHandler(async (req, res) => {
    await connectDB();
    const user = await User.findOne({ emailVerificationTokenHash: hashToken(req.params.token) });
    if (!user) return res.json({ status: "invalid" });
    if (user.emailVerified) return res.json({ status: "already_verified" });
    if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      return res.json({ status: "expired" });
    }
    res.json({ status: "valid", email: user.email });
  })
);

authRouter.post(
  "/verify-email/:token",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    await connectDB();
    const user = await User.findOne({ emailVerificationTokenHash: hashToken(req.params.token) });
    if (!user) return badRequest(res, "Invalid or expired verification link");
    if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      return badRequest(res, "This verification link has expired. Request a new one.");
    }

    user.emailVerified = true;
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpiresAt = null;
    await user.save();

    await logSecurityEvent({ userId: user._id, action: "email_verified", ip: clientIp(req) });
    res.json({ ok: true });
  })
);

authRouter.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);
    if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });

    const { allowed } = rateLimit(`resend-verification:${user._id}`, { limit: 5, windowMs: 60 * 60 * 1000 });
    if (!allowed) return badRequest(res, "Too many requests. Please try again later.");

    await connectDB();
    await issueEmailVerification(user);
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
      // Out-of-band signal: this account's real owner should hear about it
      // even though they're the one who (should have) just done it — if
      // this wasn't them, the revoked sessions alone are a silent event
      // they'd otherwise have no way to notice.
      sendTemplatedEmail("security_alert", { user, vars: { security_alert_context: "" } });

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
      sendTemplatedEmail("security_alert", {
        user,
        vars: { security_alert_context: " via the forgot-password flow" },
      });

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

// GDPR-style "export my data" — everything the account deletion flow above
// destroys, as a downloadable JSON snapshot the user can keep. Scoped to
// the account's own metadata and history, not a bulk re-download of every
// original photo/video file it owns — those already have their own
// per-item download path (see media.js's /:id/file with ?download=1), and
// bundling every original into one export response would be a very
// different (streaming/zip, potentially gigabytes) feature.
authRouter.get(
  "/export-data",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();

    const [ownedTimelines, memberships, orders, activity] = await Promise.all([
      Timeline.find({ ownerId: user._id, deletedAt: null }).select("title slug description createdAt").lean(),
      Membership.find({ userId: user._id, status: "active" }).populate("timelineId", "title slug").lean(),
      Order.find({ userId: user._id }).lean(),
      ActivityLog.find({ userId: user._id, kind: "activity" }).sort({ createdAt: -1 }).limit(1000).lean(),
    ]);

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      account: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        dob: user.dob,
        gender: user.gender,
        phone: user.phone,
        country: user.country,
        role: user.role,
        credits: user.credits,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      },
      ownedTimelines: ownedTimelines.map((t) => ({
        title: t.title,
        slug: t.slug,
        description: t.description,
        createdAt: t.createdAt,
      })),
      memberships: memberships
        .filter((m) => m.timelineId)
        .map((m) => ({ timeline: m.timelineId.title, slug: m.timelineId.slug, role: m.role, joinedAt: m.joinedAt })),
      orders: orders.map((o) => ({
        id: o._id.toString(),
        gatewayProvider: o.gatewayProvider,
        amount: o.amount,
        currency: o.currency,
        credits: o.credits,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
      })),
      // Security-kind events (logins, lockouts) are deliberately excluded —
      // this mirrors what the in-app activity feed already shows the user
      // about themselves, not the indefinitely-retained security log.
      activity: activity.map((a) => ({ action: a.action, createdAt: a.createdAt, metadata: a.metadata })),
    };

    await logSecurityEvent({ userId: user._id, action: "data_export_requested", ip: clientIp(req) });

    res.setHeader("Content-Disposition", `attachment; filename="timeline-data-export-${user._id}.json"`);
    res.json(exportPayload);
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

// Keeps the device making this request signed in and revokes every other
// active session — distinct from POST /logout's {everywhere:true}, which
// ends the current session too. Handy after noticing an unrecognized
// device in the list without that also signing yourself out.
authRouter.post(
  "/sessions/revoke-others",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const currentToken = req.cookies?.[REFRESH_COOKIE];
    const currentHash = currentToken ? hashToken(currentToken) : null;
    const currentSession = currentHash ? await Session.findOne({ refreshTokenHash: currentHash }) : null;

    await revokeAllSessionsForUser(user._id, "user_revoked_others", {
      exceptSessionId: currentSession?._id,
    });

    await logSecurityEvent({ userId: user._id, action: "sessions_revoked_others", ip: clientIp(req) });

    res.json({ ok: true });
  })
);
