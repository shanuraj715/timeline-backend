import { z } from "zod";

export const updateMediaSchema = z.object({
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  captureDate: z.coerce.date().optional(),
  location: z
    .object({
      name: z.string().trim().max(200).optional().default(""),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
    })
    .optional(),
  favorite: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  people: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
});

export const searchMediaSchema = z.object({
  q: z.string().trim().max(200).optional(),
  year: z.coerce.number().int().min(1800).max(3000).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  tags: z.array(z.string()).optional(),
  people: z.array(z.string()).optional(),
  location: z.string().trim().max(200).optional(),
  favorite: z.coerce.boolean().optional(),
  type: z.enum(["image", "video"]).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
