import { z } from "zod";

// Upper bound is defensive hygiene, not a real limit anyone should hit —
// catches a fat-fingered or malicious request before it reaches the
// multiple-of-unit check in the route handler (which needs the *current*
// storageUnitBytes from PlatformSettings, so it can't be expressed here).
const MAX_PURCHASE_BYTES = 1024 * 1024 * 1024 * 1024; // 1TB

export const purchaseStorageSchema = z.object({
  bytes: z.number().int().positive().max(MAX_PURCHASE_BYTES),
});
