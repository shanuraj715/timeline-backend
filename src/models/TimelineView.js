import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// One row per (timeline, logged-in viewer) pair — upserted on each view
// (see routes/timelines.js's GET /:slug), not an append-only event log, so
// the "who viewed this" list (once unlocked, see ViewerListUnlock) is a
// list of unique people, not a firehose of every page load. The owner's
// own views are never recorded here. Truly anonymous views (no user at
// all) can't be attributed to anyone and are instead only counted in
// Timeline.guestViewCount.
const TimelineViewSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    viewCount: { type: Number, default: 1, min: 1 },
    lastViewedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

TimelineViewSchema.index({ timelineId: 1, userId: 1 }, { unique: true });

export default models.TimelineView || model("TimelineView", TimelineViewSchema);
