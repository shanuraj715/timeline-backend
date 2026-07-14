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
    settings: {
      allowMemberUploads: { type: Boolean, default: true },
      defaultRole: { type: String, enum: ["viewer", "editor"], default: "viewer" },
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

TimelineSchema.index({ ownerId: 1, deletedAt: 1 });

export default models.Timeline || model("Timeline", TimelineSchema);
