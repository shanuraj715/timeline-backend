import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via lib/recaptchaSettings.js, mirrors
// PlatformSettings' fixed-_id pattern for the same reason (exactly one
// document, no upsert race).
const SINGLETON_ID = "recaptcha-settings";

const RecaptchaSettingsSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    // Site keys are meant to be public — Google's own widget embeds them
    // directly in page HTML/JS, so this is stored and served in plain text.
    siteKey: { type: String, trim: true, default: "" },
    // Encrypted at rest via lib/crypto.js, same as PaymentGateway credentials
    // — this one actually is secret. Empty string means "not configured".
    secretKeyEncrypted: { type: String, default: "" },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.RecaptchaSettings || model("RecaptchaSettings", RecaptchaSettingsSchema);
