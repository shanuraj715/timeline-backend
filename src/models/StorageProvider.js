import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// A configured storage backend — local disk or an S3-compatible bucket
// (AWS S3, Cloudflare R2, MinIO, Backblaze B2, ...). Exactly one provider
// is ever `isActive: true`; every read/write in the app goes through
// whichever one that is (see lib/storage/index.js's getStorage()). Secrets
// are encrypted at rest with the same AES-256-GCM convention used for
// payment gateway/reCAPTCHA secrets (lib/crypto.js).
const StorageProviderSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // "s3"/"r2" are both handled by the same S3-compatible driver — the
    // distinction is cosmetic (which endpoint pattern the admin form
    // pre-fills) plus lets the UI show a recognizable icon/label.
    type: { type: String, enum: ["local", "s3", "r2"], required: true },
    isActive: { type: Boolean, default: false, index: true },

    // --- local ---
    localPath: { type: String, default: "" },

    // --- s3 / r2 ---
    bucket: { type: String, default: "" },
    region: { type: String, default: "" },
    // Empty for real AWS S3 (SDK default endpoint); required for R2/MinIO/
    // any other S3-compatible provider.
    endpoint: { type: String, default: "" },
    forcePathStyle: { type: Boolean, default: false },
    accessKeyId: { type: String, default: "" },
    // AES-256-GCM ciphertext (see lib/crypto.js), never the plaintext key.
    secretAccessKeyEncrypted: { type: String, default: "" },

    // Soft, admin-informational cap — nothing in S3/R2/local disk enforces
    // this; it only drives a usage-bar warning in the admin UI.
    quotaBytes: { type: Number, default: null },

    // Cached usage, since summing a large bucket's object sizes on every
    // page load would mean a full LIST pass per request. Recomputed by a
    // periodic background pass or an admin-triggered "Recalculate".
    usageBytes: { type: Number, default: 0 },
    objectCount: { type: Number, default: 0 },
    usageComputedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default models.StorageProvider || model("StorageProvider", StorageProviderSchema);
