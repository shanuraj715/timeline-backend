import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #0a84ff");
// "" means "use the app's default styling" — distinct from primary/
// secondary/background, which always have a real color.
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
      background: hexColor.default("#fbfbfd"),
      node: optionalHexColor,
      edge: optionalHexColor,
      dateChipBackground: optionalHexColor,
      dateChipText: optionalHexColor,
    })
    .default({}),
  imagePosition: z.enum(["center", "top", "bottom"]).default("center"),
  overlayStyle: z.enum(["gradient", "solid", "none"]).default("gradient"),
  overlayOpacity: z.number().int().min(0).max(100).default(60),
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
