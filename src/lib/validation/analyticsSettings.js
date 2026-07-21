import { z } from "zod";

// GA4 Measurement IDs always look like "G-XXXXXXXXXX" — validated here (and
// re-checked once more right before the frontend interpolates it into an
// inline <script>, see app/layout.jsx) since, unlike a plain display string,
// this value ends up inside hand-authored JavaScript rather than just text.
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/;

export const updateAnalyticsSettingsSchema = z.object({
  measurementId: z
    .string()
    .trim()
    .max(30)
    .default("")
    .refine((v) => v === "" || MEASUREMENT_ID_PATTERN.test(v), "Measurement ID must look like G-XXXXXXXXXX"),
  enabled: z.boolean().default(false),
});
