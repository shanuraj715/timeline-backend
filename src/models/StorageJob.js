import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// A single background storage operation — either a migration between two
// providers or an orphan scan of one provider. Deliberately one model for
// both rather than two: they share the exact same lifecycle concerns (long
// -running, must survive a server restart, admin-cancellable, progress-
// trackable) and the worker loop (lib/storage/worker.js) polls one
// collection instead of two.
//
// State lives entirely in Mongo, not in memory — the worker loop is just a
// setInterval poll that re-derives what to do next from `status` on every
// tick, so a server restart mid-job resumes exactly where it left off
// without any special recovery code.
const StorageJobSchema = new Schema(
  {
    type: { type: String, enum: ["migration", "orphan_scan"], required: true },

    // --- migration-only fields ---
    sourceProviderId: { type: Schema.Types.ObjectId, ref: "StorageProvider", default: null },
    targetProviderId: { type: Schema.Types.ObjectId, ref: "StorageProvider", default: null },
    mode: { type: String, enum: ["move", "copy"], default: null },

    // --- orphan_scan-only fields ---
    providerId: { type: Schema.Types.ObjectId, ref: "StorageProvider", default: null },

    status: {
      type: String,
      enum: [
        "planning", // enumerating source keys (migration) or listing bucket (orphan_scan)
        "running", // transferring files (migration) or reconciling keys (orphan_scan)
        "verifying", // migration only: re-diffing source vs copied before cutover
        "cutover", // migration only: flipping the active provider
        "cleanup", // migration only: deleting source files after a successful "move"
        "completed",
        "cancelling",
        "cancelled",
        "failed",
      ],
      default: "planning",
      index: true,
    },

    totalFiles: { type: Number, default: 0 },
    totalBytes: { type: Number, default: 0 },
    processedFiles: { type: Number, default: 0 },
    processedBytes: { type: Number, default: 0 },
    failedFiles: { type: Number, default: 0 },

    // S3 ListObjectsV2 continuation token / local-disk directory-walk
    // cursor — lets the planning phase resume a huge bucket listing across
    // multiple worker ticks instead of blocking one tick until it's fully
    // enumerated.
    listCursor: { type: String, default: null },

    // How many source<->verify convergence passes have run — see
    // migrationWorker.js's runVerifying() for why this is capped.
    verifyPasses: { type: Number, default: 0 },

    // orphan_scan working state: every key listed from the bucket during
    // the "planning" phase, reconciled against in-use keys and cleared
    // (via $unset) once "running" produces the final orphanedKeys list.
    scannedKeys: {
      type: [{ key: String, size: Number }],
      default: undefined,
    },
    // orphan_scan result: keys present in the bucket but not referenced by
    // any Media/Theme/CmsMedia record (or, for CmsMedia, not currently
    // referenced by any Page/FooterColumn content).
    orphanedKeys: {
      type: [{ key: String, size: Number }],
      default: undefined,
    },

    errorMessage: { type: String, default: null },
    startedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

StorageJobSchema.index({ type: 1, status: 1 });

export default models.StorageJob || model("StorageJob", StorageJobSchema);
