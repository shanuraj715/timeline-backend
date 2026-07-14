import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const PageSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    content: { type: String, default: "" }, // Markdown source
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    seoTitle: { type: String, trim: true, maxlength: 150, default: "" },
    seoDescription: { type: String, trim: true, maxlength: 300, default: "" },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default models.Page || model("Page", PageSchema);
