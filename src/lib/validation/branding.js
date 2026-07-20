import { z } from "zod";

export const updateBrandingSettingsSchema = z
  .object({
    siteName: z.string().trim().min(1, "Site name is required").max(80).default("Timeline"),
    logoMode: z.enum(["text", "image"]).default("text"),
    logoImageLight: z.string().trim().max(500).default(""),
    logoImageDark: z.string().trim().max(500).default(""),
    logoImageHeight: z.number().int().min(16).max(120).default(32),
    footerTagline: z.string().trim().max(300).default(""),
    footerLogoMode: z.enum(["text", "image"]).default("text"),
    footerLogoImageLight: z.string().trim().max(500).default(""),
    footerLogoImageDark: z.string().trim().max(500).default(""),
    footerLogoImageHeight: z.number().int().min(16).max(120).default(32),
    footerAlign: z.enum(["left", "center", "right"]).default("left"),
  })
  // Dark is only meaningful as an override of Light — never allowed to be
  // the only variant set, both so the "upload light first" admin-UI rule
  // has a real backend guarantee, and so the frontend's ThemeImage never
  // has to handle a dark-only case. Same rule, independently, for the
  // footer's own logo pair.
  .refine((data) => !data.logoImageDark || data.logoImageLight, {
    message: "Upload a light theme logo before setting a dark theme logo",
    path: ["logoImageDark"],
  })
  .refine((data) => !data.footerLogoImageDark || data.footerLogoImageLight, {
    message: "Upload a light theme footer logo before setting a dark theme footer logo",
    path: ["footerLogoImageDark"],
  });
