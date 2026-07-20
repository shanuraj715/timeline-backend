import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Existence of a row = the "who viewed this timeline" list is permanently
// unlocked for that timeline, regardless of who paid. One purchase per
// timeline, ever — mirrors models/ThemeUnlock.js exactly, just keyed on
// timelineId alone (unique, not a compound index) since this isn't a
// per-item unlock.
const ViewerListUnlockSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, unique: true },
    purchasedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    creditsSpent: { type: Number, required: true, min: 0 }, // price snapshot at purchase time
  },
  { timestamps: true }
);

export default models.ViewerListUnlock || model("ViewerListUnlock", ViewerListUnlockSchema);
