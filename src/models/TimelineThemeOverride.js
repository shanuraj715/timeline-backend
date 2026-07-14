import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// A date-range (inclusive, single day = startDate === endDate) during which
// a different theme than the timeline's base theme auto-applies — e.g. a
// birthday theme on June 1st every... no, a single specific date, not
// recurring. Overlaps with another override on the same timeline are
// rejected at creation time (see routes/timelines.js), so resolution never
// has to pick a winner between two matching overrides.
const TimelineThemeOverrideSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    themeId: { type: Schema.Types.ObjectId, ref: "Theme", required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    label: { type: String, trim: true, maxlength: 100, default: "" },
  },
  { timestamps: true }
);

TimelineThemeOverrideSchema.index({ timelineId: 1, startDate: 1, endDate: 1 });

export default models.TimelineThemeOverride || model("TimelineThemeOverride", TimelineThemeOverrideSchema);
