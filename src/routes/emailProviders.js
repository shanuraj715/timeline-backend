import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import EmailProvider from "../models/EmailProvider.js";
import { invalidateEmailProviderCache } from "../lib/email/index.js";
import { upsertEmailProviderSchema } from "../lib/validation/email.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { encryptSecret, decryptSecret, maskSecret, MASK_PREFIX } from "../lib/crypto.js";

export const emailProvidersRouter = Router();

const KNOWN_PROVIDERS = ["sendgrid", "sendpulse", "resend", "smtp"];

function decryptCredentials(encrypted = {}) {
  return Object.fromEntries(Object.entries(encrypted).map(([k, v]) => [k, decryptSecret(v)]));
}

function serialize(provider) {
  const decrypted = decryptCredentials(provider.credentials);
  return {
    provider: provider.provider,
    isEnabled: provider.isEnabled,
    isDefault: provider.isDefault,
    credentials: Object.fromEntries(Object.entries(decrypted).map(([k, v]) => [k, maskSecret(v)])),
    config: provider.config,
    updatedAt: provider.updatedAt,
  };
}

emailProvidersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "notifications.providers");
    if (!admin) return;
    await connectDB();
    const providers = await EmailProvider.find({});
    res.json({ providers: providers.map(serialize) });
  })
);

emailProvidersRouter.put(
  "/:provider",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "notifications.providers");
    if (!admin) return;

    const providerKey = req.params.provider;
    if (!KNOWN_PROVIDERS.includes(providerKey)) return badRequest(res, "Unknown email provider");

    const data = parseJson(req, res, upsertEmailProviderSchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await EmailProvider.findOne({ provider: providerKey });
      const existingCredentials = existing?.credentials || {};

      // Same masked-placeholder-keeps-existing / real-value-encrypts merge
      // as routes/payments.js's gateway PUT — see that file's comment for
      // the full reasoning.
      const mergedCredentials = {};
      for (const [key, value] of Object.entries(data.credentials)) {
        if (!value) continue;
        if (value.startsWith(MASK_PREFIX) && existingCredentials[key]) {
          mergedCredentials[key] = existingCredentials[key];
        } else {
          mergedCredentials[key] = encryptSecret(value);
        }
      }

      const provider = await EmailProvider.findOneAndUpdate(
        { provider: providerKey },
        {
          $set: {
            isEnabled: data.isEnabled,
            isDefault: data.isDefault,
            credentials: mergedCredentials,
            config: data.config,
          },
        },
        { upsert: true, new: true }
      );

      if (data.isDefault) {
        await EmailProvider.updateMany({ provider: { $ne: providerKey } }, { $set: { isDefault: false } });
      }

      invalidateEmailProviderCache();
      res.json({ provider: serialize(provider) });
    } catch (err) {
      serverError(res, err, "Failed to save email provider");
    }
  })
);

emailProvidersRouter.delete(
  "/:provider",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "notifications.providers");
    if (!admin) return;

    await connectDB();
    const provider = await EmailProvider.findOneAndDelete({ provider: req.params.provider });
    if (!provider) return notFound(res, "Provider not found");
    invalidateEmailProviderCache();
    res.json({ ok: true });
  })
);
