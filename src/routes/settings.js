import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import { getPlatformSettings, updatePlatformSettings } from "../lib/platformSettings.js";
import { updatePlatformSettingsSchema } from "../lib/validation/settings.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requireSuperAdmin, getCurrentUser, unauthorized } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const settingsRouter = Router();

function serialize(settings) {
  return {
    freeStorageBytesPerTimeline: settings.freeStorageBytesPerTimeline,
    freeTimelinesPerAccount: settings.freeTimelinesPerAccount,
    creditsPerExtraTimeline: settings.creditsPerExtraTimeline,
  };
}

// Any authenticated user can read these — the create-timeline and
// buy-storage flows need them to show accurate limits/prices, not just
// the admin panel.
settingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const settings = await getPlatformSettings();
    res.json({ settings: serialize(settings) });
  })
);

settingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const data = parseJson(req, res, updatePlatformSettingsSchema);
    if (!data) return;

    try {
      await connectDB();
      const settings = await updatePlatformSettings(data);
      res.json({ settings: serialize(settings) });
    } catch (err) {
      serverError(res, err, "Failed to update settings");
    }
  })
);
