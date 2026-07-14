import { z } from "zod";

export const updateRecaptchaSettingsSchema = z.object({
  siteKey: z.string().trim().max(200).default(""),
  // Plain on the wire; the route encrypts it before it touches the
  // database. A masked "****xxxx" value means "leave the stored secret
  // unchanged" (same convention as PaymentGateway credentials), an empty
  // string clears it.
  secretKey: z.string().trim().max(200).default(""),
});
