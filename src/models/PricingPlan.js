import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const PricingPlanSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    credits: { type: Number, required: true, min: 1 },
    priceInPaise: { type: Number, required: true, min: 0 }, // smallest currency unit (paise for INR)
    currency: { type: String, default: "INR", uppercase: true, trim: true, maxlength: 3 },
    isActive: { type: Boolean, default: true, index: true },
    isFeatured: { type: Boolean, default: false },
    order: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

export default models.PricingPlan || model("PricingPlan", PricingPlanSchema);
