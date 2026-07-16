import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const CouponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 40 },
    type: { type: String, enum: ["fixed", "percentage"], required: true },
    // Paise when type is "fixed", 1-100 when type is "percentage".
    value: { type: Number, required: true, min: 1 },
    // Empty array = applies to every active pricing plan.
    applicablePlanIds: { type: [Schema.Types.ObjectId], ref: "PricingPlan", default: [] },
    isActive: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date, default: null },
    // null = unlimited redemptions.
    maxRedemptions: { type: Number, default: null, min: 1 },
    redemptionCount: { type: Number, default: 0, min: 0 },
    // Restricts redemption to accounts created within a window, checked
    // against User.createdAt in routes/coupons.js's resolveCoupon():
    // "relative" = within the last N days of *now* (an evergreen "new
    // users only" coupon that keeps working as time passes), "absolute" =
    // between two fixed calendar dates (a one-off campaign window).
    // "none" (default) applies no restriction at all.
    accountAgeRule: {
      type: { type: String, enum: ["none", "relative", "absolute"], default: "none" },
      relativeDays: { type: Number, default: null, min: 1 },
      startDate: { type: Date, default: null },
      endDate: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

export default models.Coupon || model("Coupon", CouponSchema);
