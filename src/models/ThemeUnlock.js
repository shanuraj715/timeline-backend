import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Existence of a row = that theme is usable (as base theme or override) on
// that timeline, permanently, regardless of who unlocked it. One purchase
// per (timeline, theme) pair, ever — never re-charged.
const ThemeUnlockSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    themeId: { type: Schema.Types.ObjectId, ref: "Theme", required: true },
    purchasedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    creditsSpent: { type: Number, required: true, min: 0 }, // price snapshot at purchase time
  },
  { timestamps: true }
);

ThemeUnlockSchema.index({ timelineId: 1, themeId: 1 }, { unique: true });

export default models.ThemeUnlock || model("ThemeUnlock", ThemeUnlockSchema);
