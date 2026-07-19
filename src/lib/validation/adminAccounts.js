import { z } from "zod";
import { PERMISSION_KEYS } from "../permissions.js";

const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must include at least one letter")
  .regex(/[0-9]/, "Password must include at least one number");

// `password`/`name` are only required when the email doesn't match an
// existing account (routes/adminAccounts.js checks that at runtime, not
// here, since it depends on a DB lookup zod can't do).
export const grantAdminAccessSchema = z.object({
  email,
  name: z.string().trim().min(1).max(120).optional(),
  password: password.optional(),
  permissions: z.array(z.enum(PERMISSION_KEYS)).default([]),
});

export const updateAdminPermissionsSchema = z.object({
  permissions: z.array(z.enum(PERMISSION_KEYS)),
});
