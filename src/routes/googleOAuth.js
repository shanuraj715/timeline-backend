import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import { getGoogleOAuthSettings, updateGoogleOAuthSettings } from "../lib/googleOAuthSettings.js";
import { updateGoogleOAuthSettingsSchema } from "../lib/validation/googleOAuth.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logSecurityEvent } from "../lib/logger.js";
import { encryptSecret, decryptSecret, maskSecret, MASK_PREFIX } from "../lib/crypto.js";

export const googleOAuthRouter = Router();
export const publicGoogleOAuthRouter = Router();

// The secret is only ever decrypted here, at the point of masking for
// display — never returned in full, same guarantee reCAPTCHA/PaymentGateway
// serialization already gives their own credentials.
function serialize(settings) {
  return {
    clientId: settings.clientId,
    isEnabled: settings.isEnabled,
    clientSecretConfigured: Boolean(settings.clientSecretEncrypted),
    clientSecretMasked: settings.clientSecretEncrypted ? maskSecret(decryptSecret(settings.clientSecretEncrypted)) : "",
  };
}

googleOAuthRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.settings");
    if (!admin) return;

    await connectDB();
    const settings = await getGoogleOAuthSettings();
    res.json(serialize(settings));
  })
);

googleOAuthRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.settings");
    if (!admin) return;

    const data = parseJson(req, res, updateGoogleOAuthSettingsSchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await getGoogleOAuthSettings();

      // Same convention as reCAPTCHA/PaymentGateway credentials: a masked
      // placeholder coming back from the admin UI means "leave the stored
      // secret alone" — re-encrypting the mask itself would corrupt the
      // real value. An empty string clears it; anything else is encrypted fresh.
      const patch = { clientId: data.clientId, isEnabled: data.isEnabled };
      const secretUnchanged = data.clientSecret.startsWith(MASK_PREFIX) && existing.clientSecretEncrypted;
      if (!secretUnchanged) {
        patch.clientSecretEncrypted = data.clientSecret ? encryptSecret(data.clientSecret) : "";
      }

      const settings = await updateGoogleOAuthSettings(patch);

      await logSecurityEvent({
        userId: admin._id,
        action: "admin_updated_google_oauth_settings",
        ip: clientIp(req),
        metadata: { clientIdChanged: existing.clientId !== settings.clientId, secretChanged: !secretUnchanged, isEnabled: settings.isEnabled },
      });

      res.json(serialize(settings));
    } catch (err) {
      serverError(res, err, "Failed to update Google sign-in settings");
    }
  })
);

// Public: only ever the client ID (safe to expose — it's embedded in the
// authorization redirect URL the browser is sent to anyway) plus whether
// the button should even render. The secret never appears here.
publicGoogleOAuthRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const settings = await getGoogleOAuthSettings();
    const enabled = settings.isEnabled && Boolean(settings.clientId) && Boolean(settings.clientSecretEncrypted);
    res.json({ enabled, clientId: enabled ? settings.clientId : null });
  })
);
