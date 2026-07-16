import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// One record per file uploaded through the CMS rich-text editor's image/
// video button (routes/cms.js's POST /media). Without this, an uploaded
// file has literally nothing in the database referencing it — fine for
// serving it back (the key is deterministic), but it means orphan
// detection has no way to enumerate "every CMS file that was ever
// uploaded" to check against what's still actually referenced in a Page's
// content or a FooterColumn's HTML (see lib/storage/orphanScan.js).
const CmsMediaSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    filename: { type: String, required: true },
    mime: { type: String, required: true },
    type: { type: String, enum: ["image", "video"], required: true },
    size: { type: Number, required: true },
    uploadedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default models.CmsMedia || model("CmsMedia", CmsMediaSchema);
