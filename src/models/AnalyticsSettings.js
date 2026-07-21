import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via getAnalyticsSettings()/
// updateAnalyticsSettings() in lib/analyticsSettings.js, same fixed-_id
// pattern as AdSettings/PlatformSettings.
const SINGLETON_ID = "analytics-settings";

const AnalyticsSettingsSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    // A GA4 Measurement ID ("G-XXXXXXXXXX") isn't a secret — Google's own
    // gtag.js snippet embeds it directly in every page's HTML source, so
    // this is stored and returned in plain text, unlike GoogleOAuthSettings'
    // client secret.
    measurementId: { type: String, trim: true, maxlength: 30, default: "" },
    // Independent of whether measurementId is set — an admin can toggle
    // this on before pasting an ID, same as RecaptchaSettings/
    // GoogleOAuthSettings; the public route computes the real effective
    // on/off state from both fields together.
    enabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.AnalyticsSettings || model("AnalyticsSettings", AnalyticsSettingsSchema);
