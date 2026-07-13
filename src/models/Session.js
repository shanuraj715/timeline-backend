import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Represents one refresh-token "chain". Each use of the refresh token
// rotates it (new hash, same document) and remembers the previous hash so
// that a replay of an already-rotated token can be detected as theft.
const SessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    refreshTokenHash: { type: String, required: true },
    previousTokenHash: { type: String, default: null },
    device: { type: String, default: "Unknown device" },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
    rememberMe: { type: Boolean, default: false },
    revoked: { type: Boolean, default: false },
    revokedReason: { type: String, default: null },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default models.Session || model("Session", SessionSchema);
