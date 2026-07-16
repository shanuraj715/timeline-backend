import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import { getPlatformSettings, updatePlatformSettings } from "../lib/platformSettings.js";
import { invalidateMaintenanceCache } from "../lib/maintenance.js";
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
    defaultCreditsOnSignup: settings.defaultCreditsOnSignup,
    storageUnitBytes: settings.storageUnitBytes,
    storageUnitPriceCredits: settings.storageUnitPriceCredits,
    maintenanceMode: {
      enabled: Boolean(settings.maintenanceMode?.enabled),
      message: settings.maintenanceMode?.message || "",
    },
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

    // maintenanceMode is flattened to dot-path keys before being handed to
    // updatePlatformSettings's `$set` — Mongo's $set replaces a nested
    // object wholesale, so sending `{ maintenanceMode: { enabled: true } }`
    // as-is would silently wipe out a previously-saved message.
    const { maintenanceMode, ...patch } = data;
    if (maintenanceMode) {
      if (maintenanceMode.enabled !== undefined) patch["maintenanceMode.enabled"] = maintenanceMode.enabled;
      if (maintenanceMode.message !== undefined) patch["maintenanceMode.message"] = maintenanceMode.message;
    }

    try {
      await connectDB();
      const settings = await updatePlatformSettings(patch);
      // Cheap and always-correct beats conditionally checking whether this
      // particular payload touched maintenanceMode — this route is only
      // ever called from the admin settings screen, not a hot path.
      invalidateMaintenanceCache();
      res.json({ settings: serialize(settings) });
    } catch (err) {
      serverError(res, err, "Failed to update settings");
    }
  })
);
