import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Purchasable storage add-ons for a timeline — same shape/spirit as
// PricingPlan (credits <-> a fixed benefit), just granting bytes on a
// timeline's quota instead of account-wide credits.
const StoragePlanSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    bytes: { type: Number, required: true, min: 1 },
    priceCredits: { type: Number, required: true, min: 1 },
    isActive: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

export default models.StoragePlan || model("StoragePlan", StoragePlanSchema);
