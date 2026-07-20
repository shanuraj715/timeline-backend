import { z } from "zod";

export const createTimelineSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  description: z.string().trim().max(2000).optional().default(""),
});

export const updateTimelineSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  coverMediaId: z.string().length(24).nullable().optional(),
  visibility: z.enum(["private", "shared", "public"]).optional(),
  settings: z
    .object({
      allowMemberUploads: z.boolean().optional(),
      defaultRole: z.enum(["viewer", "editor"]).optional(),
      guestViewEnabled: z.boolean().optional(),
    })
    .optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(["admin", "editor", "viewer"]),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]),
});
