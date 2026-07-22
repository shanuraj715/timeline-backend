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
    // Which client created this session — "web" for every session predating
    // this field (and every browser login going forward), "android"/"ios"
    // for the mobile app. Lets the sessions list (GET /api/auth/sessions)
    // eventually show "MyTimelyne for Android" instead of parsing a mobile
    // HTTP client's own non-browser User-Agent string, which describeDevice()
    // has no heuristic for.
    platform: { type: String, enum: ["web", "android", "ios"], default: "web" },
    revoked: { type: Boolean, default: false },
    revokedReason: { type: String, default: null },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default models.Session || model("Session", SessionSchema);
