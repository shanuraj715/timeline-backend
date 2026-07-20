import { z } from "zod";

// Same 12-key allowlist as HOMEPAGE_ICONS (lib/validation/homepageContent.js)
// — kept in lockstep with the admin panel's icon <Select>
// (timeline-admin/src/pages/WhyChooseUs.jsx) and the public frontend's
// icon-name -> lucide-component lookup
// (timeline/src/app/(public)/why-mytimelyne/page.jsx). Duplicated rather
// than imported, matching how HOMEPAGE_ICONS itself is duplicated across
// its own three locations in this codebase.
export const WHY_ICONS = [
  "sparkles",
  "shield",
  "clock",
  "users",
  "heart",
  "globe",
  "zap",
  "layers",
  "lock",
  "camera",
  "cloud",
  "infinity",
];

// Dark is only meaningful as an override of Light — same rule as
// BrandingSettings/HomepageContent (see either for the full reasoning).
const darkRequiresLight = (data) => !data.imageUrlDark || data.imageUrlLight;
const darkRequiresLightIssue = {
  message: "Upload a light theme image before setting a dark theme image",
  path: ["imageUrlDark"],
};

const heroSchema = z
  .object({
    eyebrow: z.string().trim().max(80).default(""),
    heading: z.string().trim().max(150).default(""),
    subheading: z.string().trim().max(300).default(""),
    imageUrlLight: z.string().trim().max(500).default(""),
    imageUrlDark: z.string().trim().max(500).default(""),
  })
  .refine(darkRequiresLight, darkRequiresLightIssue);

const reasonSchema = z
  .object({
    icon: z.enum(WHY_ICONS).default("sparkles"),
    title: z.string().trim().max(100).default(""),
    description: z.string().trim().max(300).default(""),
    imageUrlLight: z.string().trim().max(500).default(""),
    imageUrlDark: z.string().trim().max(500).default(""),
  })
  .refine(darkRequiresLight, darkRequiresLightIssue);

const competitorSchema = z.object({
  name: z.string().trim().max(60).default(""),
  logoUrl: z.string().trim().max(500).default(""),
});

const comparisonRowSchema = z.object({
  label: z.string().trim().max(100).default(""),
  usValue: z.string().trim().max(80).default(""),
  competitorValues: z.array(z.string().trim().max(80)).default([]),
});

const faqItemSchema = z.object({
  question: z.string().trim().max(150).default(""),
  answer: z.string().trim().max(500).default(""),
});

const ctaSchema = z.object({
  heading: z.string().trim().max(150).default(""),
  subheading: z.string().trim().max(300).default(""),
  buttonLabel: z.string().trim().max(60).default(""),
  buttonUrl: z.string().trim().max(300).default(""),
});

export const updateWhyChooseUsContentSchema = z
  .object({
    seoTitle: z.string().trim().max(150).default(""),
    seoDescription: z.string().trim().max(300).default(""),
    hero: heroSchema.default({}),
    reasonsHeading: z.string().trim().max(150).default(""),
    reasonsSubheading: z.string().trim().max(300).default(""),
    reasons: z.array(reasonSchema).max(8).default([]),
    couplesHeading: z.string().trim().max(150).default(""),
    couplesSubheading: z.string().trim().max(300).default(""),
    couplesReasons: z.array(reasonSchema).max(8).default([]),
    comparisonHeading: z.string().trim().max(150).default(""),
    comparisonSubheading: z.string().trim().max(300).default(""),
    comparisonUsLabel: z.string().trim().max(60).default("MyTimelyne"),
    competitors: z.array(competitorSchema).max(4).default([]),
    comparisonRows: z.array(comparisonRowSchema).max(10).default([]),
    securityHeading: z.string().trim().max(150).default(""),
    securitySubheading: z.string().trim().max(300).default(""),
    securityItems: z.array(faqItemSchema).max(8).default([]),
    storageHeading: z.string().trim().max(150).default(""),
    storageSubheading: z.string().trim().max(300).default(""),
    storageItems: z.array(faqItemSchema).max(8).default([]),
    privacyHeading: z.string().trim().max(150).default(""),
    privacySubheading: z.string().trim().max(300).default(""),
    privacyItems: z.array(faqItemSchema).max(8).default([]),
    pricingHeading: z.string().trim().max(150).default(""),
    pricingSubheading: z.string().trim().max(300).default(""),
    pricingItems: z.array(faqItemSchema).max(8).default([]),
    familyHeading: z.string().trim().max(150).default(""),
    familySubheading: z.string().trim().max(300).default(""),
    familyItems: z.array(faqItemSchema).max(8).default([]),
    cta: ctaSchema.default({}),
  })
  // Every row's per-competitor values must line up 1:1 with the current
  // competitors list — the admin UI keeps this in sync automatically when
  // a competitor is added/removed, this is the server-side backstop.
  .refine((data) => data.comparisonRows.every((row) => row.competitorValues.length === data.competitors.length), {
    message: "Each comparison row must have exactly one value per competitor",
    path: ["comparisonRows"],
  });
