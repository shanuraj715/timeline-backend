import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must include at least one letter")
  .regex(/[0-9]/, "Password must include at least one number");

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email,
  password,
  recaptchaToken: z.string().optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required").max(128),
  rememberMe: z.boolean().optional().default(false),
  recaptchaToken: z.string().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, "Password is required").max(128),
});
