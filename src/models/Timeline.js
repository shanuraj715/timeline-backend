import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const TimelineSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    coverMediaId: { type: Schema.Types.ObjectId, ref: "Media", default: null },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    themeId: { type: Schema.Types.ObjectId, ref: "Theme", default: null },
    // The *delta* from the site-wide free tier, in bytes — not stored as an
    // absolute quota. A timeline's effective quota is always computed live
    // as PlatformSettings.freeStorageBytesPerTimeline + purchasedStorageBytes
    // (see getTimelineStorageQuota() in lib/storageQuota.js), so raising the
    // free tier in the admin panel immediately benefits every timeline that
    // hasn't bought extra space, not just new ones. Usually >= 0 (a user's
    // own purchases only ever add), but deliberately has no min: an admin
    // overriding one timeline's quota below the current free default (see
    // routes/admin.js's PATCH .../storage) needs this to go negative.
    purchasedStorageBytes: { type: Number, default: 0 },
    // "shared" (default) is today's original-and-only behavior — visible
    // only to explicit Membership rows via invitation. "private" is owner
    // -only, full stop. "public" additionally allows any logged-in account
    // to view without a Membership, and — only when both this timeline's
    // own settings.guestViewEnabled AND the platform-wide
    // PlatformSettings.allowGuestViewing are true — truly anonymous
    // viewing too. See lib/auth/guards.js's resolveTimelineViewAccess,
    // the single place this is actually enforced.
    visibility: { type: String, enum: ["private", "shared", "public"], default: "shared" },
    // Rough aggregate of anonymous (not-logged-in) views — never tied to an
    // identity, so it's a counter rather than a row in TimelineView.
    guestViewCount: { type: Number, default: 0, min: 0 },
    settings: {
      allowMemberUploads: { type: Boolean, default: true },
      defaultRole: { type: String, enum: ["viewer", "editor"], default: "viewer" },
      // Owner's own opt-in on top of visibility === "public" — only takes
      // effect when the platform-wide PlatformSettings.allowGuestViewing is
      // also on. Defaults off: a newly-public timeline still requires
      // login until the owner explicitly flips this.
      guestViewEnabled: { type: Boolean, default: false },
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

TimelineSchema.index({ ownerId: 1, deletedAt: 1 });

export default models.Timeline || model("Timeline", TimelineSchema);
