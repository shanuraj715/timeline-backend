import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const FeatureFlagSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default models.FeatureFlag || model("FeatureFlag", FeatureFlagSchema);
