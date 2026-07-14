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
    // A timeline can buy extra storage in whole multiples of this many bytes,
    // each multiple costing storageUnitPriceCredits — e.g. 100MB/10 credits
    // means 300MB costs 30 credits, but 150MB is rejected outright (not a
    // whole multiple). See routes/timelines.js's storage/purchase route.
    storageUnitBytes: { type: Number, default: 100 * 1024 * 1024, min: 1 },
    storageUnitPriceCredits: { type: Number, default: 10, min: 1 },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.PlatformSettings || model("PlatformSettings", PlatformSettingsSchema);
