import { z } from "zod";

const childLinkSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  url: z.string().trim().min(1, "URL is required").max(300),
  order: z.number().int().default(0),
  openInNewTab: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const navItemSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  url: z.string().trim().min(1, "URL is required").max(300),
  order: z.number().int().default(0),
  openInNewTab: z.boolean().default(false),
  enabled: z.boolean().default(true),
  children: z.array(childLinkSchema).max(20).default([]),
});

export const navItemReorderSchema = z.object({
  items: z.array(z.object({ id: z.string().length(24), order: z.number().int() })).min(1),
});

const footerLinkSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  url: z.string().trim().min(1, "URL is required").max(300),
  order: z.number().int().default(0),
  openInNewTab: z.boolean().default(false),
});

export const footerColumnSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(80),
  order: z.number().int().default(0),
  enabled: z.boolean().default(true),
  links: z.array(footerLinkSchema).max(30).default([]),
});

export const footerColumnReorderSchema = z.object({
  items: z.array(z.object({ id: z.string().length(24), order: z.number().int() })).min(1),
});

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createPageSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(150),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Slug is required")
    .max(150)
    .regex(slugPattern, "Slug must be lowercase letters, numbers, and hyphens only"),
  content: z.string().max(200_000).default(""),
  status: z.enum(["draft", "published"]).default("draft"),
  seoTitle: z.string().trim().max(150).default(""),
  seoDescription: z.string().trim().max(300).default(""),
});

export const updatePageSchema = createPageSchema.partial();
