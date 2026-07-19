import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import Coupon from "../models/Coupon.js";
import PricingPlan from "../models/PricingPlan.js";
import { createCouponSchema, updateCouponSchema, applyCouponSchema } from "../lib/validation/coupons.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, getCurrentUser, unauthorized, notFound, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { rateLimit } from "../lib/auth/rateLimit.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const couponsRouter = Router();

function serializeCoupon(coupon) {
  return {
    id: coupon._id.toString(),
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    applicablePlanIds: coupon.applicablePlanIds.map((id) => id.toString()),
    isActive: coupon.isActive,
    expiresAt: coupon.expiresAt,
    maxRedemptions: coupon.maxRedemptions,
    redemptionCount: coupon.redemptionCount,
    accountAgeRule: {
      type: coupon.accountAgeRule?.type || "none",
      relativeDays: coupon.accountAgeRule?.relativeDays ?? null,
      startDate: coupon.accountAgeRule?.startDate ?? null,
      endDate: coupon.accountAgeRule?.endDate ?? null,
    },
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

// Shared by /apply here (a checkout preview) and payments.js's actual
// checkout route (which must re-run this itself — never trust a
// client-supplied discount) — one place defines what makes a coupon valid
// for a given plan, and how much it's worth. `user` is required (not
// optional) precisely because of the accountAgeRule check below — a coupon
// can't be resolved without knowing whose account is redeeming it.
export async function resolveCoupon(code, planId, user) {
  const coupon = await Coupon.findOne({ code: code.trim().toUpperCase() });
  if (!coupon) return { ok: false, error: "Invalid coupon code" };
  if (!coupon.isActive) return { ok: false, error: "This coupon is no longer active" };
  if (coupon.expiresAt && coupon.expiresAt < new Date()) return { ok: false, error: "This coupon has expired" };
  if (coupon.maxRedemptions !== null && coupon.redemptionCount >= coupon.maxRedemptions) {
    return { ok: false, error: "This coupon has reached its redemption limit" };
  }
  if (coupon.applicablePlanIds.length > 0 && !coupon.applicablePlanIds.some((id) => id.toString() === planId)) {
    return { ok: false, error: "This coupon isn't valid for the selected plan" };
  }

  const rule = coupon.accountAgeRule;
  if (rule?.type === "relative") {
    const cutoff = new Date(Date.now() - rule.relativeDays * 24 * 60 * 60 * 1000);
    if (user.createdAt < cutoff) {
      return { ok: false, error: `This coupon is only valid for accounts created in the last ${rule.relativeDays} days` };
    }
  } else if (rule?.type === "absolute") {
    if (user.createdAt < rule.startDate || user.createdAt > rule.endDate) {
      return { ok: false, error: "This coupon isn't valid for your account" };
    }
  }

  return { ok: true, coupon };
}

export function computeDiscount(coupon, priceInPaise) {
  const discount =
    coupon.type === "percentage" ? Math.round((priceInPaise * coupon.value) / 100) : coupon.value;
  return Math.min(discount, priceInPaise);
}

// ---- Admin CRUD ----

couponsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "commerce.coupons");
    if (!admin) return;
    await connectDB();
    const coupons = await Coupon.find({}).sort({ createdAt: -1 });
    res.json({ coupons: coupons.map(serializeCoupon) });
  })
);

couponsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.coupons");
    if (!admin) return;

    const data = parseJson(req, res, createCouponSchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await Coupon.findOne({ code: data.code });
      if (existing) return badRequest(res, "A coupon with this code already exists");

      const coupon = await Coupon.create(data);
      res.status(201).json({ coupon: serializeCoupon(coupon) });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A coupon with this code already exists");
      serverError(res, err, "Failed to create coupon");
    }
  })
);

couponsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.coupons");
    if (!admin) return;

    const data = parseJson(req, res, updateCouponSchema);
    if (!data) return;

    try {
      await connectDB();
      if (data.code) {
        const existing = await Coupon.findOne({ code: data.code, _id: { $ne: req.params.id } });
        if (existing) return badRequest(res, "A coupon with this code already exists");
      }

      const coupon = await Coupon.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
      if (!coupon) return notFound(res, "Coupon not found");
      res.json({ coupon: serializeCoupon(coupon) });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A coupon with this code already exists");
      serverError(res, err, "Failed to update coupon");
    }
  })
);

couponsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.coupons");
    if (!admin) return;

    await connectDB();
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return notFound(res, "Coupon not found");
    res.json({ ok: true });
  })
);

// ---- Checkout-time preview (any authenticated user) ----

couponsRouter.post(
  "/apply",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    // Unlike login/register, this is authenticated-only, but still scriptable
    // against a wordlist of guessed codes with no throttle otherwise — a
    // coupon's existence/discount is real value worth protecting the same
    // way credential-guessing endpoints already are.
    const { allowed } = rateLimit(`coupon-apply:${clientIp(req)}`, { limit: 15, windowMs: 15 * 60 * 1000 });
    if (!allowed) return badRequest(res, "Too many attempts. Please try again later.");

    const data = parseJson(req, res, applyCouponSchema);
    if (!data) return;

    await connectDB();
    const plan = await PricingPlan.findOne({ _id: data.planId, isActive: true });
    if (!plan) return notFound(res, "Plan not found");

    const planAmount = plan.prices.get(data.currency);
    if (planAmount == null) return badRequest(res, "This plan isn't priced in the selected currency");

    const result = await resolveCoupon(data.code, data.planId, user);
    if (!result.ok) return badRequest(res, result.error);

    const discountAmount = computeDiscount(result.coupon, planAmount);
    res.json({
      valid: true,
      discountAmount,
      finalAmount: planAmount - discountAmount,
    });
  })
);
