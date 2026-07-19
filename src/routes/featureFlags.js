import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import FeatureFlag from "../models/FeatureFlag.js";
import { createFeatureFlagSchema, updateFeatureFlagSchema } from "../lib/validation/featureFlags.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const featureFlagsRouter = Router();
export const publicFeatureFlagsRouter = Router();

featureFlagsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.flags");
    if (!admin) return;
    await connectDB();
    const flags = await FeatureFlag.find({}).sort({ key: 1 });
    res.json({ flags });
  })
);

featureFlagsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.flags");
    if (!admin) return;

    const data = parseJson(req, res, createFeatureFlagSchema);
    if (!data) return;

    try {
      await connectDB();
      const flag = await FeatureFlag.create(data);
      res.status(201).json({ flag });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A flag with this key already exists");
      serverError(res, err, "Failed to create feature flag");
    }
  })
);

featureFlagsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.flags");
    if (!admin) return;

    const data = parseJson(req, res, updateFeatureFlagSchema);
    if (!data) return;

    await connectDB();
    const flag = await FeatureFlag.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
    if (!flag) return notFound(res, "Feature flag not found");
    res.json({ flag });
  })
);

featureFlagsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.flags");
    if (!admin) return;

    await connectDB();
    const flag = await FeatureFlag.findByIdAndDelete(req.params.id);
    if (!flag) return notFound(res, "Feature flag not found");
    res.json({ ok: true });
  })
);

publicFeatureFlagsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const flags = await FeatureFlag.find({});
    const map = Object.fromEntries(flags.map((f) => [f.key, f.enabled]));
    res.json({ flags: map });
  })
);
