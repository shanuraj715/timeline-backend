import { z } from "zod";

export const createStorageProviderSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    type: z.enum(["local", "s3", "r2"]),
    localPath: z.string().trim().max(500).default(""),
    bucket: z.string().trim().max(255).default(""),
    region: z.string().trim().max(100).default(""),
    endpoint: z.string().trim().max(500).default(""),
    forcePathStyle: z.boolean().default(false),
    accessKeyId: z.string().trim().max(255).default(""),
    secretAccessKey: z.string().max(1000).default(""),
    quotaBytes: z.number().int().min(0).nullable().default(null),
  })
  .refine((data) => data.type !== "local" || data.localPath.length > 0, {
    message: "Local path is required for a local disk provider",
    path: ["localPath"],
  })
  .refine((data) => data.type === "local" || data.bucket.length > 0, {
    message: "Bucket name is required",
    path: ["bucket"],
  });

export const updateStorageProviderSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  localPath: z.string().trim().max(500).optional(),
  bucket: z.string().trim().max(255).optional(),
  region: z.string().trim().max(100).optional(),
  endpoint: z.string().trim().max(500).optional(),
  forcePathStyle: z.boolean().optional(),
  accessKeyId: z.string().trim().max(255).optional(),
  // "" means "leave the existing secret unchanged" — the masked-value
  // convention already used for payment gateway/reCAPTCHA secrets
  // (crypto.js's MASK_PREFIX).
  secretAccessKey: z.string().max(1000).optional(),
  quotaBytes: z.number().int().min(0).nullable().optional(),
});

export const activateProviderSchema = z.object({
  mode: z.enum(["move", "copy"]).optional(),
});

export const orphanScanSchema = z.object({
  providerId: z.string().length(24).optional(),
});

export const deleteOrphanFilesSchema = z.object({
  providerId: z.string().length(24),
  keys: z.array(z.string().min(1)).min(1).max(500),
});
