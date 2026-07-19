import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import { getRecaptchaSettings, updateRecaptchaSettings } from "../lib/recaptchaSettings.js";
import { updateRecaptchaSettingsSchema } from "../lib/validation/recaptcha.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logSecurityEvent } from "../lib/logger.js";
import { isFeatureEnabled } from "../lib/featureFlags.js";
import { encryptSecret, decryptSecret, maskSecret, MASK_PREFIX } from "../lib/crypto.js";

export const recaptchaRouter = Router();
export const publicRecaptchaRouter = Router();

// The secret is only ever decrypted here, at the point of masking for
// display — never returned in full, same guarantee PaymentGateway's own
// serializeGateway() gives its credentials.
function serialize(settings) {
  return {
    siteKey: settings.siteKey,
    secretKeyConfigured: Boolean(settings.secretKeyEncrypted),
    secretKeyMasked: settings.secretKeyEncrypted ? maskSecret(decryptSecret(settings.secretKeyEncrypted)) : "",
  };
}

recaptchaRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.settings");
    if (!admin) return;

    await connectDB();
    const settings = await getRecaptchaSettings();
    res.json(serialize(settings));
  })
);

recaptchaRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.settings");
    if (!admin) return;

    const data = parseJson(req, res, updateRecaptchaSettingsSchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await getRecaptchaSettings();

      // Same convention as PaymentGateway credentials: a masked placeholder
      // coming back from the admin UI means "leave the stored secret
      // alone" — re-encrypting the mask itself would corrupt the real
      // value. An empty string clears it; anything else is encrypted fresh.
      const patch = { siteKey: data.siteKey };
      const secretUnchanged = data.secretKey.startsWith(MASK_PREFIX) && existing.secretKeyEncrypted;
      if (!secretUnchanged) {
        patch.secretKeyEncrypted = data.secretKey ? encryptSecret(data.secretKey) : "";
      }

      const settings = await updateRecaptchaSettings(patch);

      await logSecurityEvent({
        userId: admin._id,
        action: "admin_updated_recaptcha_settings",
        ip: clientIp(req),
        metadata: { siteKeyChanged: existing.siteKey !== settings.siteKey, secretKeyChanged: !secretUnchanged },
      });

      res.json(serialize(settings));
    } catch (err) {
      serverError(res, err, "Failed to update reCAPTCHA settings");
    }
  })
);

// Public: only ever the site key (safe — Google's widget embeds it in page
// HTML by design) plus a single "should the frontend even bother" flag.
// The secret key never appears on this router or anywhere else outside
// verifyRecaptcha() itself.
publicRecaptchaRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const settings = await getRecaptchaSettings();
    const configured = Boolean(settings.siteKey) && Boolean(settings.secretKeyEncrypted);
    const enabled = configured && (await isFeatureEnabled("recaptcha_enabled"));

    res.json({ enabled, siteKey: enabled ? settings.siteKey : null });
  })
);
