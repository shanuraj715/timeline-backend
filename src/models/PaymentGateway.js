import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// `credentials` holds provider secrets (e.g. Razorpay key_secret, webhook
// secret) as strings already encrypted via lib/crypto.js's encryptSecret()
// — never store or return plaintext. `config` holds non-secret,
// provider-specific settings (e.g. a UPI VPA, a display label).
const PaymentGatewaySchema = new Schema(
  {
    provider: { type: String, enum: ["razorpay", "phonepe", "upi", "mock"], required: true, unique: true },
    isEnabled: { type: Boolean, default: false, index: true },
    isDefault: { type: Boolean, default: false },
    mode: { type: String, enum: ["test", "live"], default: "test" },
    credentials: { type: Schema.Types.Mixed, default: {} },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export default models.PaymentGateway || model("PaymentGateway", PaymentGatewaySchema);
