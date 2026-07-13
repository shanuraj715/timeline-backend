import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const MembershipSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: ["owner", "admin", "editor", "viewer"], required: true },
    status: { type: String, enum: ["active", "pending"], default: "active" },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

MembershipSchema.index({ timelineId: 1, userId: 1 }, { unique: true });
MembershipSchema.index({ userId: 1, status: 1 });

export default models.Membership || model("Membership", MembershipSchema);
