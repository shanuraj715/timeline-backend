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
    // Credited to every new account at registration — see routes/auth.js's
    // /register handler. 0 means no signup bonus.
    defaultCreditsOnSignup: { type: Number, default: 0, min: 0 },
    // A timeline can buy extra storage in whole multiples of this many bytes,
    // each multiple costing storageUnitPriceCredits — e.g. 100MB/10 credits
    // means 300MB costs 30 credits, but 150MB is rejected outright (not a
    // whole multiple). See routes/timelines.js's storage/purchase route.
    storageUnitBytes: { type: Number, default: 100 * 1024 * 1024, min: 1 },
    storageUnitPriceCredits: { type: Number, default: 10, min: 1 },
    // Global kill switch for anonymous (not-logged-in) viewing of a Public
    // timeline — off means every public timeline requires login regardless
    // of any individual timeline's own settings.guestViewEnabled. See
    // Timeline.js's visibility field and guards.js's resolveTimelineViewAccess.
    allowGuestViewing: { type: Boolean, default: false },
    // One-time price to unlock the "who viewed this timeline" list —
    // see models/ViewerListUnlock.js and lib/viewerListUnlock.js.
    viewerListUnlockPriceCredits: { type: Number, default: 20, min: 1 },
    // Read on (almost) every API request via lib/maintenance.js's
    // in-memory cache, not this document directly — see that file for why.
    maintenanceMode: {
      enabled: { type: Boolean, default: false },
      message: {
        type: String,
        default: "We're currently performing scheduled maintenance. We'll be back shortly.",
        maxlength: 500,
      },
    },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.PlatformSettings || model("PlatformSettings", PlatformSettingsSchema);
