import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must include at least one letter")
  .regex(/[0-9]/, "Password must include at least one number");

const MIN_AGE_YEARS = 13;

function isAtLeastYearsOld(date, years) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return date <= cutoff;
}

export const registerSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(60),
  lastName: z.string().trim().min(1, "Last name is required").max(60),
  email,
  password,
  dob: z.coerce
    .date({ errorMap: () => ({ message: "Enter a valid date of birth" }) })
    .refine((d) => d < new Date(), "Date of birth must be in the past")
    .refine((d) => isAtLeastYearsOld(d, MIN_AGE_YEARS), `You must be at least ${MIN_AGE_YEARS} years old`),
  gender: z.enum(["male", "female", "other", "prefer_not_to_say"], {
    errorMap: () => ({ message: "Select a gender" }),
  }),
  phone: z.string().trim().max(20).optional(),
  country: z.string().trim().max(100).optional(),
  // .nullish() (not .optional()) — lib/recaptcha.js's getRecaptchaToken()
  // explicitly resolves to `null`, not `undefined`, whenever reCAPTCHA
  // isn't configured/enabled (its own documented contract), so the schema
  // has to accept both or every register/login attempt fails validation
  // the moment reCAPTCHA is off.
  recaptchaToken: z.string().nullish(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required").max(128),
  rememberMe: z.boolean().optional().default(false),
  // .nullish() (not .optional()) — lib/recaptcha.js's getRecaptchaToken()
  // explicitly resolves to `null`, not `undefined`, whenever reCAPTCHA
  // isn't configured/enabled (its own documented contract), so the schema
  // has to accept both or every register/login attempt fails validation
  // the moment reCAPTCHA is off.
  recaptchaToken: z.string().nullish(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, "Password is required").max(128),
});

export const forgotPasswordSchema = z.object({
  email,
});

export const resetPasswordSchema = z.object({
  email,
  otp: z.string().trim().length(6, "Enter the 6-digit code"),
  newPassword: password,
});
