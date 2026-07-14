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
  },
  { timestamps: true }
);

export default models.Coupon || model("Coupon", CouponSchema);
