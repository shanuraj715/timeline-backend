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
      // Optional overrides for the timeline's node/edge/date-chip styling —
      // "" means "use the app's default styling" rather than this theme's
      // own color. Kept separate from primary/secondary (which drive the
      // page-level background wash) since a theme designer may want the
      // wash colors without changing the timeline's own line/dot chrome.
      node: { type: String, default: "" },
      edge: { type: String, default: "" },
      dateChipBackground: { type: String, default: "" },
      dateChipText: { type: String, default: "" },
    },
    // Storage key (via lib/storage) for the uploaded background/preview
    // image — same abstraction Media already uses, not a separate asset
    // pipeline.
    imageKey: { type: String, default: null },
    imageMimeType: { type: String, default: null },
    imagePosition: { type: String, enum: ["center", "top", "bottom"], default: "center" },
    // How the background wash's color layer combines with the image:
    // "gradient" (primary->secondary diagonal, the default), "solid" (flat
    // primary tint), or "none" (raw image only, no color layer).
    overlayStyle: { type: String, enum: ["gradient", "solid", "none"], default: "gradient" },
    overlayOpacity: { type: Number, min: 0, max: 100, default: 60 },
    // 0 = free/unlocked for every timeline with no purchase needed.
    priceCredits: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    isDefault: { type: Boolean, default: false, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default models.Theme || model("Theme", ThemeSchema);
