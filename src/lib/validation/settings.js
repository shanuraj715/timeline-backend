import { z } from "zod";

export const updatePlatformSettingsSchema = z.object({
  freeStorageBytesPerTimeline: z.number().int().min(0).optional(),
  freeTimelinesPerAccount: z.number().int().min(0).optional(),
  creditsPerExtraTimeline: z.number().int().min(0).optional(),
});
