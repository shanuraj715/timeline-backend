import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import PricingPlan from "../models/PricingPlan.js";
import { createPricingPlanSchema, updatePricingPlanSchema } from "../lib/validation/pricing.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requireSuperAdmin, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const pricingRouter = Router();
export const publicPricingRouter = Router();

pricingRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;
    await connectDB();
    const plans = await PricingPlan.find({}).sort({ order: 1, createdAt: 1 });
    res.json({ plans });
  })
);

pricingRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const data = parseJson(req, res, createPricingPlanSchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await PricingPlan.findOne({ slug: data.slug });
      if (existing) return badRequest(res, "A plan with this slug already exists");

      const plan = await PricingPlan.create(data);
      res.status(201).json({ plan });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A plan with this slug already exists");
      serverError(res, err, "Failed to create pricing plan");
    }
  })
);

pricingRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const data = parseJson(req, res, updatePricingPlanSchema);
    if (!data) return;

    try {
      await connectDB();
      if (data.slug) {
        const existing = await PricingPlan.findOne({ slug: data.slug, _id: { $ne: req.params.id } });
        if (existing) return badRequest(res, "A plan with this slug already exists");
      }

      const plan = await PricingPlan.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
      if (!plan) return notFound(res, "Pricing plan not found");
      res.json({ plan });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A plan with this slug already exists");
      serverError(res, err, "Failed to update pricing plan");
    }
  })
);

pricingRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const plan = await PricingPlan.findByIdAndDelete(req.params.id);
    if (!plan) return notFound(res, "Pricing plan not found");
    res.json({ ok: true });
  })
);

publicPricingRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const plans = await PricingPlan.find({ isActive: true }).sort({ order: 1, createdAt: 1 });
    res.json({
      plans: plans.map((p) => ({
        id: p._id.toString(),
        name: p.name,
        slug: p.slug,
        description: p.description,
        credits: p.credits,
        priceInPaise: p.priceInPaise,
        currency: p.currency,
        isFeatured: p.isFeatured,
      })),
    });
  })
);
