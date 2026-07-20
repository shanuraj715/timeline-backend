import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via getHomepageContent()/updateHomepageContent()
// in lib/homepageContent.js, never queried directly, same fixed-_id pattern as
// PlatformSettings.
const SINGLETON_ID = "homepage";

const FeatureSchema = new Schema(
  {
    icon: { type: String, default: "sparkles" },
    title: { type: String, trim: true, maxlength: 100, default: "" },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    // Optional — set via the cms-media upload flow (see routes/cms.js's
    // POST /media). Falls back to rendering `icon` when both are empty.
    // Dark is only meaningful once Light is set (enforced in
    // lib/validation/homepageContent.js) — Light is the fallback for both
    // themes when Dark is left empty.
    imageUrlLight: { type: String, trim: true, maxlength: 500, default: "" },
    imageUrlDark: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false }
);

const StatSchema = new Schema(
  {
    value: { type: String, trim: true, maxlength: 40, default: "" },
    label: { type: String, trim: true, maxlength: 80, default: "" },
  },
  { _id: false }
);

const HomepageContentSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    hero: {
      eyebrow: { type: String, trim: true, maxlength: 80, default: "" },
      heading: { type: String, trim: true, maxlength: 150, default: "" },
      subheading: { type: String, trim: true, maxlength: 300, default: "" },
      primaryCtaLabel: { type: String, trim: true, maxlength: 60, default: "" },
      primaryCtaUrl: { type: String, trim: true, maxlength: 300, default: "" },
      secondaryCtaLabel: { type: String, trim: true, maxlength: 60, default: "" },
      secondaryCtaUrl: { type: String, trim: true, maxlength: 300, default: "" },
      // Optional — set via the cms-media upload flow (see routes/cms.js's
      // POST /media). Renders as a glass-framed visual beside the hero copy;
      // the hero lays out fine without one (blobs-only, as originally shipped).
      // Same Light/Dark pairing as FeatureSchema's imageUrlLight/imageUrlDark.
      imageUrlLight: { type: String, trim: true, maxlength: 500, default: "" },
      imageUrlDark: { type: String, trim: true, maxlength: 500, default: "" },
    },
    features: { type: [FeatureSchema], default: [] },
    stats: { type: [StatSchema], default: [] },
    cta: {
      heading: { type: String, trim: true, maxlength: 150, default: "" },
      subheading: { type: String, trim: true, maxlength: 300, default: "" },
      buttonLabel: { type: String, trim: true, maxlength: 60, default: "" },
      buttonUrl: { type: String, trim: true, maxlength: 300, default: "" },
    },
    seoTitle: { type: String, trim: true, maxlength: 150, default: "" },
    seoDescription: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.HomepageContent || model("HomepageContent", HomepageContentSchema);
