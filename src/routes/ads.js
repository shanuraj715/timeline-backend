import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import { getAdSettings, updateAdSettings } from "../lib/adSettings.js";
import { getAdPlacements, getAdPlacementByKey, updateAdPlacement } from "../lib/adPlacements.js";
import { updateAdSettingsSchema, updateAdPlacementSchema } from "../lib/validation/ads.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const adsRouter = Router();
export const publicAdsRouter = Router();

function serializeSettings(settings) {
  return {
    adsEnabled: settings.adsEnabled,
    publisherId: settings.publisherId,
    adBlockDetectionEnabled: settings.adBlockDetectionEnabled,
    adBlockMessage: settings.adBlockMessage,
  };
}

function serializePlacement(placement) {
  return {
    key: placement.key,
    group: placement.group,
    label: placement.label,
    description: placement.description,
    enabled: placement.enabled,
    devices: {
      mobile: placement.devices?.mobile,
      tablet: placement.devices?.tablet,
      desktop: placement.devices?.desktop,
    },
  };
}

// ---- Admin (requires the "ads" permission) ----

adsRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "ads");
    if (!admin) return;

    await connectDB();
    const settings = await getAdSettings();
    res.json({ settings: serializeSettings(settings) });
  })
);

adsRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "ads");
    if (!admin) return;

    const data = parseJson(req, res, updateAdSettingsSchema);
    if (!data) return;

    try {
      await connectDB();
      const settings = await updateAdSettings(data);
      res.json({ settings: serializeSettings(settings) });
    } catch (err) {
      serverError(res, err, "Failed to update ad settings");
    }
  })
);

adsRouter.get(
  "/placements",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "ads");
    if (!admin) return;

    await connectDB();
    const placements = await getAdPlacements();
    res.json({ placements: placements.map(serializePlacement) });
  })
);

adsRouter.put(
  "/placements/:key",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "ads");
    if (!admin) return;

    const data = parseJson(req, res, updateAdPlacementSchema);
    if (!data) return;

    // `devices` is flattened to dot-path keys before being handed to
    // updateAdPlacement's `$set` — Mongo's $set replaces a nested object
    // wholesale, so a caller that only sent `devices.mobile` (like a future
    // per-device-only edit) would otherwise silently wipe out tablet/
    // desktop. Same fix settings.js's maintenanceMode uses. Today's only
    // two real callers either omit `devices` entirely (the inline enabled
    // toggle) or send all three tiers together (the edit modal), but this
    // keeps a partial call safe either way.
    const { devices, ...patch } = data;
    if (devices) {
      if (devices.mobile !== undefined) patch["devices.mobile"] = devices.mobile;
      if (devices.tablet !== undefined) patch["devices.tablet"] = devices.tablet;
      if (devices.desktop !== undefined) patch["devices.desktop"] = devices.desktop;
    }

    try {
      await connectDB();
      const existing = await getAdPlacementByKey(req.params.key);
      if (!existing) return notFound(res, "Ad placement not found");

      const placement = await updateAdPlacement(req.params.key, patch);
      res.json({ placement: serializePlacement(placement) });
    } catch (err) {
      serverError(res, err, "Failed to update ad placement");
    }
  })
);

// ---- Public (no auth) — read by every ad-bearing page, anonymous or not ----

publicAdsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const [settings, placements] = await Promise.all([getAdSettings(), getAdPlacements()]);
    res.json({
      settings: serializeSettings(settings),
      placements: placements.map(serializePlacement),
    });
  })
);
