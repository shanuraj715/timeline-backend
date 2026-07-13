import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const ActivityLogSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", default: null, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    // "security": login/lockout/session events — never shown to family members, kept indefinitely.
    // "activity": timeline-facing feed (uploads, edits, invites) — retained ~3 years.
    kind: { type: String, enum: ["security", "activity"], required: true, index: true },
    action: { type: String, required: true },
    targetType: { type: String, default: null },
    targetId: { type: Schema.Types.ObjectId, default: null },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

ActivityLogSchema.index({ timelineId: 1, createdAt: -1 });
ActivityLogSchema.index({ userId: 1, createdAt: -1 });
ActivityLogSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 60 * 60 * 24 * 365 * 3,
    partialFilterExpression: { kind: "activity" },
  }
);

export default models.ActivityLog || model("ActivityLog", ActivityLogSchema);
