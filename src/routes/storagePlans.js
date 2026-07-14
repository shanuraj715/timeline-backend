import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import StoragePlan from "../models/StoragePlan.js";
import StoragePurchase from "../models/StoragePurchase.js";
import { createStoragePlanSchema, updateStoragePlanSchema } from "../lib/validation/storagePlans.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requireSuperAdmin, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const storagePlansRouter = Router();

export function serializeStoragePlan(plan) {
  return {
    id: plan._id.toString(),
    name: plan.name,
    bytes: plan.bytes,
    priceCredits: plan.priceCredits,
    isActive: plan.isActive,
    order: plan.order,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

storagePlansRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;
    await connectDB();
    const plans = await StoragePlan.find({}).sort({ order: 1, bytes: 1 });
    res.json({ plans: plans.map(serializeStoragePlan) });
  })
);

storagePlansRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const data = parseJson(req, res, createStoragePlanSchema);
    if (!data) return;

    try {
      await connectDB();
      const plan = await StoragePlan.create(data);
      res.status(201).json({ plan: serializeStoragePlan(plan) });
    } catch (err) {
      serverError(res, err, "Failed to create storage plan");
    }
  })
);

storagePlansRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const data = parseJson(req, res, updateStoragePlanSchema);
    if (!data) return;

    await connectDB();
    const plan = await StoragePlan.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
    if (!plan) return notFound(res, "Storage plan not found");
    res.json({ plan: serializeStoragePlan(plan) });
  })
);

storagePlansRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const used = await StoragePurchase.countDocuments({ storagePlanId: req.params.id });
    if (used > 0) {
      return badRequest(res, "This storage plan has already been purchased by a timeline and can't be deleted — disable it instead");
    }

    const plan = await StoragePlan.findByIdAndDelete(req.params.id);
    if (!plan) return notFound(res, "Storage plan not found");
    res.json({ ok: true });
  })
);
