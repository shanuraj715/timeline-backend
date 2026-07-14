import { z } from "zod";

export const createFeatureFlagSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Key is required")
    .max(60)
    .regex(/^[a-z0-9_]+$/, "Key must be lowercase letters, numbers, and underscores only"),
  label: z.string().trim().min(1, "Label is required").max(100),
  description: z.string().trim().max(300).default(""),
  enabled: z.boolean().default(true),
});

export const updateFeatureFlagSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(300).optional(),
  enabled: z.boolean().optional(),
});
