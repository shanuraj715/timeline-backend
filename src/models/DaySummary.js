import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Materialized one-row-per-day cache that drives the horizontal timeline.
// Kept in sync by lib/media/daySummary.js whenever Media becomes ready,
// is soft-deleted/restored, or favorited — never written to directly by
// request handlers, and always rebuildable from Media as the source of truth.
const DaySummarySchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    dayKey: { type: String, required: true }, // YYYYMMDD
    date: { type: Date, required: true },
    mediaCount: { type: Number, default: 0 },
    favoriteCount: { type: Number, default: 0 },
    coverMediaId: { type: Schema.Types.ObjectId, ref: "Media", default: null },
  },
  { timestamps: true }
);

DaySummarySchema.index({ timelineId: 1, dayKey: 1 }, { unique: true });
DaySummarySchema.index({ timelineId: 1, date: 1 });

export default models.DaySummary || model("DaySummary", DaySummarySchema);
