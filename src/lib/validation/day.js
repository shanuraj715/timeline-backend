import { z } from "zod";

export const updateDayCaptionSchema = z.object({
  caption: z.string().trim().max(300),
});
