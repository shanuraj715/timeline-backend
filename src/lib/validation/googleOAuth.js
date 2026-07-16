import { z } from "zod";

export const updateGoogleOAuthSettingsSchema = z.object({
  clientId: z.string().trim().max(200).default(""),
  // Plain on the wire; the route encrypts it before it touches the
  // database. A masked "****xxxx" value means "leave the stored secret
  // unchanged" (same convention as PaymentGateway/reCAPTCHA credentials),
  // an empty string clears it.
  clientSecret: z.string().trim().max(200).default(""),
  isEnabled: z.boolean().default(false),
});
