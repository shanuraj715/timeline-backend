import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #0a84ff");
// "" means "use the app's default styling" — distinct from primary/
// secondary, which always have a real color.
const optionalHexColor = z.union([hexColor, z.literal("")]).default("");
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createThemeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Slug is required")
    .max(100)
    .regex(slugPattern, "Slug must be lowercase letters, numbers, and hyphens only"),
  category: z.string().trim().max(60).default(""),
  description: z.string().trim().max(500).default(""),
  colors: z
    .object({
      primary: hexColor.default("#0a84ff"),
      secondary: hexColor.default("#6e6e73"),
      node: optionalHexColor,
      edge: optionalHexColor,
      dateChipBackground: optionalHexColor,
      dateChipText: optionalHexColor,
      nodeBorder: optionalHexColor,
    })
    .default({}),
  imagePosition: z.enum(["center", "top", "bottom"]).default("center"),
  overlayStyle: z.enum(["gradient", "solid", "none"]).default("gradient"),
  overlayOpacity: z.number().int().min(0).max(100).default(60),
  glassEffect: z.boolean().default(false),
  glassBlur: z.number().int().min(0).max(40).default(20),
  particleEffect: z.enum(["none", "sparkles", "leaves", "hearts", "confetti", "gifts", "snow"]).default("none"),
  particleCount: z.number().int().min(5).max(60).default(24),
  particleSpeed: z.number().min(0.5).max(3).default(1),
  particleMinSize: z.number().int().min(4).max(60).default(14),
  particleMaxSize: z.number().int().min(4).max(80).default(34),
  particleInteractive: z.boolean().default(false),
  particleInteractionStrength: z.number().min(0.5).max(3).default(1),
  nodeShape: z
    .enum(["circle", "square", "triangle", "heart", "diamond", "star", "pentagon", "hexagon"])
    .default("circle"),
  nodeBorderWidth: z.number().int().min(0).max(12).default(4),
  nodeSize: z.number().int().min(4).max(24).default(8),
  edgeStyle: z.enum(["line", "ribbon", "dashed", "dotted"]).default("line"),
  priceCredits: z.number().int().min(0).default(0),
  status: z.enum(["draft", "published"]).default("draft"),
});

export const updateThemeSchema = createThemeSchema.partial();

const isoDate = z.coerce.date();

export const createOverrideSchema = z
  .object({
    themeId: z.string().length(24),
    startDate: isoDate,
    endDate: isoDate,
    label: z.string().trim().max(100).default(""),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be on or after the start date",
    path: ["endDate"],
  });

export const setBaseThemeSchema = z.object({
  themeId: z.string().length(24),
});
