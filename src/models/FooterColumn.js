import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const FooterLinkSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true, trim: true, maxlength: 300 },
    order: { type: Number, default: 0 },
    openInNewTab: { type: Boolean, default: false },
  },
  { _id: true }
);

const FooterColumnSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    order: { type: Number, default: 0, index: true },
    enabled: { type: Boolean, default: true },
    links: { type: [FooterLinkSchema], default: [] },
  },
  { timestamps: true }
);

export default models.FooterColumn || model("FooterColumn", FooterColumnSchema);
