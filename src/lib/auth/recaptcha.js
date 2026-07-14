// Opt-in: verification only runs when RECAPTCHA_SECRET_KEY is set in .env.
// Without it, verifyRecaptcha() is a no-op that always passes — existing
// deployments that never configured reCAPTCHA keep working unchanged.
//
// On top of that, the "reCAPTCHA verification" feature flag (admin panel
// > Feature flags) is a runtime kill switch for when the keys are
// configured but an admin needs to turn verification off without editing
// .env and redeploying (e.g. Google's service is degraded, or scores are
// false-positiving real users). The flag check only runs when a secret is
// actually configured, so deployments that never set one up don't pay for
// an extra DB lookup on every login/register attempt.
import { isFeatureEnabled } from "../featureFlags.js";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const MIN_SCORE = 0.5;

export async function verifyRecaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
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
