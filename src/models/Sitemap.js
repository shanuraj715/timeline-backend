import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via getSitemap()/generateSitemap() in
// lib/sitemap.js, same fixed-_id pattern as other settings singletons. Unlike
// those, a missing document is a meaningful state ("never generated yet"),
// not just a not-yet-initialized default — see getSitemap()'s comment.
const SINGLETON_ID = "sitemap";

const SitemapSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    xml: { type: String, default: "" },
    urlCount: { type: Number, default: 0 },
    generatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.Sitemap || model("Sitemap", SitemapSchema);
