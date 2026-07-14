// Opt-in: verification only runs once a secret key is configured — via the
// admin panel (Platform > reCAPTCHA, backed by RecaptchaSettings/lib/
// recaptchaSettings.js), or RECAPTCHA_SECRET_KEY in .env as a fallback for
// deployments that set it up before the admin panel supported this. The
// DB value wins if both are set. Without either, verifyRecaptcha() is a
// no-op that always passes.
//
// On top of that, the "reCAPTCHA verification" feature flag (admin panel
// > Feature flags) is a runtime kill switch for when a key IS configured
// but an admin needs to turn verification off without touching keys at
// all (e.g. Google's service is degraded, or scores are false-positiving
// real users).
import { isFeatureEnabled } from "../featureFlags.js";
import { getRecaptchaSecretKey } from "../recaptchaSettings.js";
import { connectDB } from "../db/connect.js";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const MIN_SCORE = 0.5;

export async function verifyRecaptcha(token) {
  // Callers (login/register) invoke this before their own connectDB() —
  // this now always touches the DB (checking the configured key), unlike
  // before when an unconfigured env var made it a pure no-op, so it needs
  // to guarantee its own connection rather than depend on call order.
  await connectDB();
  const secret = (await getRecaptchaSecretKey()) || process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!(await isFeatureEnabled("recaptcha_enabled"))) return { ok: true, skipped: true, reason: "disabled_by_admin" };
  if (!token) return { ok: false, reason: "missing_token" };

  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    const data = await res.json();
    if (!data.success) return { ok: false, reason: "verification_failed" };
    if (typeof data.score === "number" && data.score < MIN_SCORE) return { ok: false, reason: "low_score" };
    return { ok: true, score: data.score };
  } catch (err) {
    console.error("reCAPTCHA verification request failed:", err);
    // Fails open — Google's own outage shouldn't lock everyone out of login.
    return { ok: true, skipped: true, reason: "verify_request_failed" };
  }
}
