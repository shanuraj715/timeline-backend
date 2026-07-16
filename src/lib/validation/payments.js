import { z } from "zod";

export const upsertGatewaySchema = z.object({
  isEnabled: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  mode: z.enum(["test", "live"]).default("test"),
  // Provider-specific: Razorpay -> { keyId, keySecret, webhookSecret }, UPI -> { vpa }, etc.
  // Values here are plain on the wire; the route layer encrypts anything
  // secret-shaped before it touches the database. Trimmed because a
  // leading/trailing space or newline from copy-pasting a key out of a
  // gateway dashboard is a real, easy-to-make mistake that silently turns
  // into "authentication failed" at checkout time with nothing in the UI
  // to suggest why.
  credentials: z.record(z.string(), z.string().trim()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const checkoutSchema = z.object({
  planId: z.string().length(24, "Invalid plan id"),
  gatewayProvider: z.enum(["razorpay", "phonepe", "upi", "mock"]),
  currency: z.string().trim().toUpperCase().length(3, "Invalid currency"),
  couponCode: z.string().trim().min(1).max(40).optional(),
});

export const verifyPaymentSchema = z.object({
  orderId: z.string().length(24),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
