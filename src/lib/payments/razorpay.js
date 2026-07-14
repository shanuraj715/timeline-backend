import crypto from "crypto";
import Razorpay from "razorpay";

// Thin wrapper over the official SDK. Requires real (test or live) API
// credentials from a Razorpay merchant account, configured via the admin
// panel's Payment Gateways screen — this module has no fallback/mock
// behavior of its own, see lib/payments/mock.js for that.

function getClient({ keyId, keySecret }) {
  if (!keyId || !keySecret) throw new Error("Razorpay is not configured with a key id/secret.");
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export async function createRazorpayOrder({ credentials, amount, currency, receipt }) {
  const client = getClient(credentials);
  const order = await client.orders.create({ amount, currency, receipt });
  return { gatewayOrderId: order.id, amount: order.amount, currency: order.currency };
}

/**
 * Razorpay SDK errors are plain objects, not Error instances — they come
 * back shaped like { statusCode, error: { code, description } } with no
 * .message at all. Passed straight to a generic 500 handler, that reason
 * (almost always a bad/mismatched API key or secret) gets silently
 * discarded and reported identically to an actual server bug. Returns the
 * human-readable description when the error looks like this shape, or
 * null otherwise so the caller can fall back to a generic error.
 */
export function describeRazorpayError(err) {
  if (err && typeof err === "object" && typeof err.error?.description === "string") {
    return err.error.description;
  }
  return null;
}

/** Verifies the signature Razorpay's Checkout widget returns after a successful payment. */
export function verifyPaymentSignature({ keySecret, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expected, razorpaySignature);
}

/** Verifies the X-Razorpay-Signature header on webhook deliveries. */
export function verifyWebhookSignature({ webhookSecret, rawBody, signature }) {
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ""), "hex");
  const bufB = Buffer.from(String(b || ""), "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
