import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const ThemeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    category: { type: String, trim: true, maxlength: 60, default: "" },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    colors: {
      primary: { type: String, default: "#0a84ff" },
      secondary: { type: String, default: "#6e6e73" },
      background: { type: String, default: "#fbfbfd" },
    },
    // Storage key (via lib/storage) for the uploaded background/preview
    // image — same abstraction Media already uses, not a separate asset
    // pipeline.
    imageKey: { type: String, default: null },
    imageMimeType: { type: String, default: null },
    // 0 = free/unlocked for every timeline with no purchase needed.
    priceCredits: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    isDefault: { type: Boolean, default: false, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default models.Theme || model("Theme", ThemeSchema);
