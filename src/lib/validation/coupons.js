import { z } from "zod";

const codePattern = /^[A-Z0-9_-]+$/;

const accountAgeRuleSchema = z
  .object({
    type: z.enum(["none", "relative", "absolute"]).default("none"),
    relativeDays: z.number().int().min(1).nullable().default(null),
    startDate: z.coerce.date().nullable().default(null),
    endDate: z.coerce.date().nullable().default(null),
  })
  .refine((r) => r.type !== "relative" || r.relativeDays, {
    message: "Enter the number of days",
    path: ["relativeDays"],
  })
  .refine((r) => r.type !== "absolute" || (r.startDate && r.endDate), {
    message: "Enter both a start and end date",
    path: ["startDate"],
  })
  .refine((r) => r.type !== "absolute" || !r.startDate || !r.endDate || r.startDate <= r.endDate, {
    message: "Start date must be before end date",
    path: ["endDate"],
  });

export const createCouponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(3, "Code must be at least 3 characters")
      .max(40)
      .regex(codePattern, "Code must be uppercase letters, numbers, hyphens, or underscores only"),
    type: z.enum(["fixed", "percentage"]),
    value: z.number().int().min(1),
    applicablePlanIds: z.array(z.string().length(24)).default([]),
    isActive: z.boolean().default(true),
    expiresAt: z.coerce.date().nullable().default(null),
    maxRedemptions: z.number().int().min(1).nullable().default(null),
    accountAgeRule: accountAgeRuleSchema.default({ type: "none", relativeDays: null, startDate: null, endDate: null }),
  })
  .refine((data) => data.type !== "percentage" || data.value <= 100, {
    message: "A percentage discount can't exceed 100",
    path: ["value"],
  });

export const updateCouponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(3)
      .max(40)
      .regex(codePattern, "Code must be uppercase letters, numbers, hyphens, or underscores only"),
    type: z.enum(["fixed", "percentage"]),
    value: z.number().int().min(1),
    applicablePlanIds: z.array(z.string().length(24)),
    isActive: z.boolean(),
    expiresAt: z.coerce.date().nullable(),
    maxRedemptions: z.number().int().min(1).nullable(),
    accountAgeRule: accountAgeRuleSchema,
  })
  .partial()
  .refine((data) => data.type !== "percentage" || !data.value || data.value <= 100, {
    message: "A percentage discount can't exceed 100",
    path: ["value"],
  });

export const applyCouponSchema = z.object({
  code: z.string().trim().min(1).max(40),
  planId: z.string().length(24),
  currency: z.string().trim().toUpperCase().length(3),
});
