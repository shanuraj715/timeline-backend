import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// One row per file a migration job needs to transfer — deliberately a
// separate collection rather than an array on StorageJob, since a large
// migration (the "100GB+, thousands of files" case) would blow past
// MongoDB's 16MB document size limit if every key were embedded on the job
// itself. This collection is also what makes cancellation exact: on
// cancel, the worker deletes every "done" row's key from the *target*
// provider and nothing else, so a bucket that already had unrelated data
// in it is never touched.
const StorageJobFileSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "StorageJob", required: true, index: true },
    key: { type: String, required: true },
    size: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "done", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },
    copiedAt: { type: Date, default: null },
    // Set once cleanup/cancel has removed this file from the source
    // (move's post-cutover cleanup) or target (a cancelled migration) —
    // lets those phases resume across ticks the same way transfer does.
    cleanedUp: { type: Boolean, default: false },
  },
  { timestamps: true }
);

StorageJobFileSchema.index({ jobId: 1, status: 1 });
StorageJobFileSchema.index({ jobId: 1, key: 1 }, { unique: true });

export default models.StorageJobFile || model("StorageJobFile", StorageJobFileSchema);
