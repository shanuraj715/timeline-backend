import { z } from "zod";

// Fixed allowlist — kept in lockstep with the admin panel's icon <Select>
// (timeline-admin/src/pages/Homepage.jsx) and the public frontend's
// icon-name -> lucide-component lookup (timeline/src/app/(public)/page.jsx).
export const HOMEPAGE_ICONS = [
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

// Dark is only meaningful as an override of Light — see BrandingSettings'
// identical refine for why (same rule, same reasoning, three places).
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
    primaryCtaLabel: z.string().trim().max(60).default(""),
    primaryCtaUrl: z.string().trim().max(300).default(""),
    secondaryCtaLabel: z.string().trim().max(60).default(""),
    secondaryCtaUrl: z.string().trim().max(300).default(""),
    imageUrlLight: z.string().trim().max(500).default(""),
    imageUrlDark: z.string().trim().max(500).default(""),
  })
  .refine(darkRequiresLight, darkRequiresLightIssue);

const featureSchema = z
  .object({
    icon: z.enum(HOMEPAGE_ICONS).default("sparkles"),
    title: z.string().trim().max(100).default(""),
    description: z.string().trim().max(300).default(""),
    imageUrlLight: z.string().trim().max(500).default(""),
    imageUrlDark: z.string().trim().max(500).default(""),
  })
  .refine(darkRequiresLight, darkRequiresLightIssue);

const statSchema = z.object({
  value: z.string().trim().max(40).default(""),
  label: z.string().trim().max(80).default(""),
});

const ctaSchema = z.object({
  heading: z.string().trim().max(150).default(""),
  subheading: z.string().trim().max(300).default(""),
  buttonLabel: z.string().trim().max(60).default(""),
  buttonUrl: z.string().trim().max(300).default(""),
});

export const updateHomepageContentSchema = z.object({
  hero: heroSchema.default({}),
  features: z.array(featureSchema).max(8).default([]),
  stats: z.array(statSchema).max(6).default([]),
  cta: ctaSchema.default({}),
  seoTitle: z.string().trim().max(150).default(""),
  seoDescription: z.string().trim().max(300).default(""),
});
