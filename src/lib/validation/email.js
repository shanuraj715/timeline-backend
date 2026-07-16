import { z } from "zod";

export const updateEmailTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(500).optional(),
  bodyHtml: z.string().min(1).optional(),
  isEnabled: z.boolean().optional(),
});

export const testEmailTemplateSchema = z.object({
  to: z.string().trim().email().optional(),
});

// Same shape as lib/validation/payments.js's upsertGatewaySchema — see
// routes/emailProviders.js for why credentials/config are handled the same
// masked-merge way as payment gateway credentials.
export const upsertEmailProviderSchema = z.object({
  isEnabled: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  credentials: z.record(z.string(), z.string().trim()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
});
