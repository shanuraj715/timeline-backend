import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import { getAnalyticsSettings, updateAnalyticsSettings } from "../lib/analyticsSettings.js";
import { updateAnalyticsSettingsSchema } from "../lib/validation/analyticsSettings.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logSecurityEvent } from "../lib/logger.js";

// Distinct from routes/analytics.js — that file is the internal visitor/
// order-metrics dashboard, unrelated to this Google Analytics *configuration*.
export const analyticsSettingsRouter = Router();
export const publicAnalyticsSettingsRouter = Router();

const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/;

function serialize(settings) {
  return { measurementId: settings.measurementId, enabled: settings.enabled };
}

analyticsSettingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.settings");
    if (!admin) return;

    await connectDB();
    const settings = await getAnalyticsSettings();
    res.json(serialize(settings));
  })
);

analyticsSettingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.settings");
    if (!admin) return;

    const data = parseJson(req, res, updateAnalyticsSettingsSchema);
    if (!data) return;

    try {
      await connectDB();
      const settings = await updateAnalyticsSettings(data);

      await logSecurityEvent({
        userId: admin._id,
        action: "admin_updated_analytics_settings",
        ip: clientIp(req),
        metadata: { enabled: settings.enabled, measurementIdConfigured: Boolean(settings.measurementId) },
      });

      res.json(serialize(settings));
    } catch (err) {
      serverError(res, err, "Failed to update Google Analytics settings");
    }
  })
);

// Public: never leaks a configured-but-disabled Measurement ID — the
// frontend only ever needs to know "should I load GA, and with which ID".
publicAnalyticsSettingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const settings = await getAnalyticsSettings();
    const enabled = settings.enabled && MEASUREMENT_ID_PATTERN.test(settings.measurementId || "");
    res.json({ enabled, measurementId: enabled ? settings.measurementId : null });
  })
);
