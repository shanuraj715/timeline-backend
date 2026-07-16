import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const PricingPlanSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    credits: { type: Number, required: true, min: 1 },
    // Keyed by ISO 4217 currency code, values in that currency's smallest
    // unit (paise for INR, cents for USD, ...). One entry per currency that
    // has ever existed in the Currency collection, enabled or not — see
    // routes/currency.js, which keeps this invariant true whenever a
    // currency is created or deleted.
    prices: { type: Map, of: Number, default: {} },
    isActive: { type: Boolean, default: true, index: true },
    isFeatured: { type: Boolean, default: false },
    order: { type: Number, default: 0, index: true },
  },
  { timestamps: true, toJSON: { flattenMaps: true }, toObject: { flattenMaps: true } }
);

export default models.PricingPlan || model("PricingPlan", PricingPlanSchema);
