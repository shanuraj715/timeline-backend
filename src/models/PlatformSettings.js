import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via getPlatformSettings()/updatePlatformSettings()
// in lib/platformSettings.js, never queried directly, so there's exactly one
// document (fixed _id) instead of relying on an upsert race to enforce that.
const SINGLETON_ID = "platform-settings";

const PlatformSettingsSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    freeStorageBytesPerTimeline: { type: Number, default: 256 * 1024 * 1024, min: 0 },
    freeTimelinesPerAccount: { type: Number, default: 2, min: 0 },
    creditsPerExtraTimeline: { type: Number, default: 20, min: 0 },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.PlatformSettings || model("PlatformSettings", PlatformSettingsSchema);
