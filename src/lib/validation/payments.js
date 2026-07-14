import { z } from "zod";

export const upsertGatewaySchema = z.object({
  isEnabled: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  mode: z.enum(["test", "live"]).default("test"),
  // Provider-specific: Razorpay -> { keyId, keySecret, webhookSecret }, UPI -> { vpa }, etc.
  // Values here are plain on the wire; the route layer encrypts anything
  // secret-shaped before it touches the database.
  credentials: z.record(z.string(), z.string()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const checkoutSchema = z.object({
  planId: z.string().length(24, "Invalid plan id"),
  gatewayProvider: z.enum(["razorpay", "phonepe", "upi", "mock"]),
});

export const verifyPaymentSchema = z.object({
  orderId: z.string().length(24),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
