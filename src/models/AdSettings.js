import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via getAdSettings()/updateAdSettings() in
// lib/adSettings.js, same fixed-_id pattern as PlatformSettings/BrandingSettings.
const SINGLETON_ID = "ad-settings";

const AdSettingsSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    // Master kill switch — off means no AdSlot anywhere ever renders
    // anything and the AdSense script never loads, regardless of any
    // individual AdPlacement's own `enabled` flag. See
    // components/shared/ad-slot.jsx and adsense-loader.jsx on the frontend.
    adsEnabled: { type: Boolean, default: true },
    // AdSense "client ID", e.g. "ca-pub-1234567890123456" — required for
    // both the loader script URL and every <ins data-ad-client>. Ads stay
    // off (AdSlot renders nothing) until this is set, even if adsEnabled
    // is true.
    publisherId: { type: String, trim: true, maxlength: 60, default: "" },
    adBlockDetectionEnabled: { type: Boolean, default: true },
    adBlockMessage: {
      type: String,
      trim: true,
      maxlength: 500,
      default:
        "We rely on ads to keep Timeline free. Please disable your ad blocker for this site and refresh the page.",
    },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.AdSettings || model("AdSettings", AdSettingsSchema);
