import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Mirrors models/PaymentGateway.js exactly: `credentials` holds secrets
// (API keys, SMTP password) already encrypted via lib/crypto.js's
// encryptSecret() — never plaintext at rest. `config` holds non-secret
// settings (fromEmail, fromName, and provider-specific bits like SMTP
// host/port/secure or an SMTP username, which isn't secret-shaped enough to
// warrant encryption on its own but travels with the rest of the connection
// config).
const EmailProviderSchema = new Schema(
  {
    provider: { type: String, enum: ["sendgrid", "sendpulse", "resend", "smtp"], required: true, unique: true },
    isEnabled: { type: Boolean, default: false, index: true },
    isDefault: { type: Boolean, default: false },
    credentials: { type: Schema.Types.Mixed, default: {} },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export default models.EmailProvider || model("EmailProvider", EmailProviderSchema);
