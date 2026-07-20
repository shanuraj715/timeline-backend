import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via getWhyChooseUsContent()/
// updateWhyChooseUsContent() in lib/whyChooseUsContent.js, never queried
// directly, same fixed-_id pattern as HomepageContent/PlatformSettings.
const SINGLETON_ID = "why-choose-us";

// Identical shape to HomepageContent.js's FeatureSchema — icon OR image,
// Dark only meaningful once Light is set (enforced in
// lib/validation/whyChooseUsContent.js).
const ReasonSchema = new Schema(
  {
    icon: { type: String, default: "sparkles" },
    title: { type: String, trim: true, maxlength: 100, default: "" },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    imageUrlLight: { type: String, trim: true, maxlength: 500, default: "" },
    imageUrlDark: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false }
);

// One column of the comparison table. A single image (not a Light/Dark
// pair) — the frontend renders it inside a small neutral chip so a logo of
// any color/background reads fine in both themes without needing two
// uploads per competitor.
const CompetitorSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 60, default: "" },
    logoUrl: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false }
);

// One row of the comparison table. `competitorValues` must stay the same
// length as the document's own `competitors` array — enforced in
// lib/validation/whyChooseUsContent.js (whole-document refine) and kept in
// sync automatically by the admin UI (adding/removing a competitor pushes/
// splices the same index across every row).
const ComparisonRowSchema = new Schema(
  {
    label: { type: String, trim: true, maxlength: 100, default: "" },
    usValue: { type: String, trim: true, maxlength: 80, default: "" },
    competitorValues: { type: [String], default: [] },
  },
  { _id: false }
);

// Used for both securityItems and storageItems — a plain question/answer
// pair rendered as one <details>/<summary> accordion item.
const FaqItemSchema = new Schema(
  {
    question: { type: String, trim: true, maxlength: 150, default: "" },
    answer: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false }
);

const WhyChooseUsContentSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    seoTitle: { type: String, trim: true, maxlength: 150, default: "" },
    seoDescription: { type: String, trim: true, maxlength: 300, default: "" },
    hero: {
      eyebrow: { type: String, trim: true, maxlength: 80, default: "" },
      heading: { type: String, trim: true, maxlength: 150, default: "" },
      subheading: { type: String, trim: true, maxlength: 300, default: "" },
      imageUrlLight: { type: String, trim: true, maxlength: 500, default: "" },
      imageUrlDark: { type: String, trim: true, maxlength: 500, default: "" },
    },
    reasonsHeading: { type: String, trim: true, maxlength: 150, default: "" },
    reasonsSubheading: { type: String, trim: true, maxlength: 300, default: "" },
    reasons: { type: [ReasonSchema], default: [] },
    // Same card shape as `reasons` above, just a second, differently-themed
    // set — couples using MyTimelyne for a shared timeline rather than a
    // whole family. Kept as its own array (not merged into `reasons`) so
    // each can be shown as its own section with its own heading.
    couplesHeading: { type: String, trim: true, maxlength: 150, default: "" },
    couplesSubheading: { type: String, trim: true, maxlength: 300, default: "" },
    couplesReasons: { type: [ReasonSchema], default: [] },
    comparisonHeading: { type: String, trim: true, maxlength: 150, default: "" },
    comparisonSubheading: { type: String, trim: true, maxlength: 300, default: "" },
    comparisonUsLabel: { type: String, trim: true, maxlength: 60, default: "MyTimelyne" },
    competitors: { type: [CompetitorSchema], default: [] },
    comparisonRows: { type: [ComparisonRowSchema], default: [] },
    securityHeading: { type: String, trim: true, maxlength: 150, default: "" },
    securitySubheading: { type: String, trim: true, maxlength: 300, default: "" },
    securityItems: { type: [FaqItemSchema], default: [] },
    storageHeading: { type: String, trim: true, maxlength: 150, default: "" },
    storageSubheading: { type: String, trim: true, maxlength: 300, default: "" },
    storageItems: { type: [FaqItemSchema], default: [] },
    // Same question/answer shape as security/storage above — three more FAQ
    // tabs so the tab strip has enough categories to fill its width.
    privacyHeading: { type: String, trim: true, maxlength: 150, default: "" },
    privacySubheading: { type: String, trim: true, maxlength: 300, default: "" },
    privacyItems: { type: [FaqItemSchema], default: [] },
    pricingHeading: { type: String, trim: true, maxlength: 150, default: "" },
    pricingSubheading: { type: String, trim: true, maxlength: 300, default: "" },
    pricingItems: { type: [FaqItemSchema], default: [] },
    familyHeading: { type: String, trim: true, maxlength: 150, default: "" },
    familySubheading: { type: String, trim: true, maxlength: 300, default: "" },
    familyItems: { type: [FaqItemSchema], default: [] },
    cta: {
      heading: { type: String, trim: true, maxlength: 150, default: "" },
      subheading: { type: String, trim: true, maxlength: 300, default: "" },
      buttonLabel: { type: String, trim: true, maxlength: 60, default: "" },
      buttonUrl: { type: String, trim: true, maxlength: 300, default: "" },
    },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.WhyChooseUsContent || model("WhyChooseUsContent", WhyChooseUsContentSchema);
