import { z } from "zod";
import { AD_SIZES } from "../../models/AdPlacement.js";

export const updateAdSettingsSchema = z.object({
  adsEnabled: z.boolean().optional(),
  publisherId: z.string().trim().max(60).optional(),
  adBlockDetectionEnabled: z.boolean().optional(),
  adBlockMessage: z.string().trim().max(500).optional(),
});

const deviceConfigSchema = z.object({
  enabled: z.boolean(),
  size: z.enum(AD_SIZES),
  adSlotId: z.string().trim().max(40),
});

// Every field optional (partial-patch semantics, same as
// updateAdSettingsSchema/updatePlatformSettingsSchema) — the admin table's
// inline "enabled" toggle sends just `{ enabled }`, while the full edit
// modal sends everything at once. `key` is intentionally never part of
// this schema — see lib/adPlacements.js's updateAdPlacement, which never
// accepts it either.
export const updateAdPlacementSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80).optional(),
  description: z.string().trim().max(300).optional(),
  enabled: z.boolean().optional(),
  devices: z
    .object({
      mobile: deviceConfigSchema.optional(),
      tablet: deviceConfigSchema.optional(),
      desktop: deviceConfigSchema.optional(),
    })
    .optional(),
});
