import { z } from "zod";

export const createCurrencySchema = z.object({
  code: z.string().trim().toUpperCase().length(3, "Currency code must be 3 letters (ISO 4217)"),
  name: z.string().trim().min(1, "Name is required").max(100),
  symbol: z.string().trim().min(1, "Symbol is required").max(10),
  isEnabled: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  order: z.number().int().default(0),
});

// `code` is intentionally excluded from updates — renaming a currency's code
// after creation would orphan every PricingPlan.prices entry keyed by the
// old code. To rename, delete and recreate instead (deletion already cleans
// up the price entries on every plan, see routes/currency.js).
export const updateCurrencySchema = createCurrencySchema.omit({ code: true }).partial();
