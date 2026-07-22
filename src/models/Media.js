import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const MediaSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    uploaderId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    type: { type: String, enum: ["image", "video"], required: true },
    storageKey: { type: String, required: true },
    thumbnailKey: { type: String, default: null },
    previewKey: { type: String, default: null },

    checksum: { type: String, required: true, index: true },
    mimeType: { type: String, required: true },
    originalFilename: { type: String, default: "" },
    size: { type: Number, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    duration: { type: Number, default: null },

    // Chronological identity — the whole point of the app.
    captureDate: { type: Date, required: true, index: true },
    dayKey: { type: String, required: true, index: true }, // YYYYMMDD in the capture timezone
    uploadDate: { type: Date, default: Date.now },
    captureDateSource: { type: String, enum: ["exif", "manual", "upload"], default: "upload" },

    title: { type: String, trim: true, maxlength: 200, default: "" },
    description: { type: String, trim: true, maxlength: 4000, default: "" },
    // Distinct from title/description — a short line meant to render directly
    // under the photo/video wherever it's actually being viewed, not tucked
    // into the Info side panel.
    caption: { type: String, trim: true, maxlength: 300, default: "" },
    location: {
      name: { type: String, default: "" },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    // Read-only, populated from the file's own EXIF at upload time (see
    // lib/media/exif.js) — unlike location, there's no manual-edit path for
    // this, since it describes the physical camera/shot, not something a
    // member would ever correct by hand.
    camera: {
      make: { type: String, default: null },
      model: { type: String, default: null },
      lens: { type: String, default: null },
      iso: { type: Number, default: null },
      fNumber: { type: Number, default: null },
      exposureTime: { type: Number, default: null },
      focalLength: { type: Number, default: null },
    },
    favorite: { type: Boolean, default: false },
    tags: { type: [String], default: [], index: true },
    people: { type: [String], default: [], index: true },

    processingStatus: {
      type: String,
      enum: ["pending", "processing", "ready", "failed"],
      default: "pending",
    },
    processingAttempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    processingError: { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MediaSchema.index({ timelineId: 1, dayKey: 1, captureDate: 1 });
MediaSchema.index({ timelineId: 1, favorite: 1, captureDate: -1 });
MediaSchema.index({ timelineId: 1, tags: 1 });
MediaSchema.index({ timelineId: 1, people: 1 });
MediaSchema.index({ timelineId: 1, checksum: 1 });
MediaSchema.index({ timelineId: 1, deletedAt: 1 });
MediaSchema.index({ processingStatus: 1, type: 1 });
// Compound text index with timelineId as an equality prefix so search stays
// scoped to one timeline instead of scoring/matching across every user's data.
MediaSchema.index(
  { timelineId: 1, title: "text", description: "text", tags: "text", people: "text" },
  { name: "media_text_search", weights: { title: 5, tags: 4, people: 4, description: 1 } }
);

export default models.Media || model("Media", MediaSchema);
