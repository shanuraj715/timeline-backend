import { z } from "zod";

export const createStoragePlanSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  bytes: z.number().int().min(1),
  priceCredits: z.number().int().min(1),
  isActive: z.boolean().default(true),
  order: z.number().int().default(0),
});

export const updateStoragePlanSchema = createStoragePlanSchema.partial();

export const purchaseStorageSchema = z.object({
  storagePlanId: z.string().length(24),
});
