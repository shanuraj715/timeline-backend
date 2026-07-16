import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// One live OTP per user at a time — routes/auth.js's /forgot-password
// deletes any prior row for the user before creating a new one. `otpHash`
// is bcrypt-hashed the same way passwords are (lib/auth/password.js),
// never the raw 6-digit code. TTL-indexed the same way Invitation.js is, so
// an expired-but-never-consumed code cleans itself up automatically.
const PasswordResetOtpSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

PasswordResetOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default models.PasswordResetOtp || model("PasswordResetOtp", PasswordResetOtpSchema);
