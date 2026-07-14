import { z } from "zod";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createPricingPlanSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Slug is required")
    .max(100)
    .regex(slugPattern, "Slug must be lowercase letters, numbers, and hyphens only"),
  description: z.string().trim().max(500).default(""),
  credits: z.number().int().min(1, "Must grant at least 1 credit"),
  priceInPaise: z.number().int().min(0, "Price can't be negative"),
  currency: z.string().trim().toUpperCase().length(3).default("INR"),
  isActive: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  order: z.number().int().default(0),
});

export const updatePricingPlanSchema = createPricingPlanSchema.partial();
