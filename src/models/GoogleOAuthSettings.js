import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — mirrors models/RecaptchaSettings.js exactly, down to the
// fixed-_id pattern. clientId is not secret (Google's own docs say it's
// safe to expose client-side); clientSecretEncrypted is, via lib/crypto.js.
const SINGLETON_ID = "google-oauth-settings";

const GoogleOAuthSettingsSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    clientId: { type: String, trim: true, default: "" },
    clientSecretEncrypted: { type: String, default: "" },
    // Separate from "are credentials present" — same convention as
    // EmailProvider/PaymentGateway's own isEnabled, letting an admin keep
    // credentials on file but turn the button off without clearing them.
    isEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.GoogleOAuthSettings || model("GoogleOAuthSettings", GoogleOAuthSettingsSchema);
