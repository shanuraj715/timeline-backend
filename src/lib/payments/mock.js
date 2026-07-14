import crypto from "crypto";

// No external dependency at all — exists so the full buy-credits flow
// (checkout -> "pay" -> credited) is genuinely testable without a real
// payment gateway account. The frontend's Mock checkout UI is expected to
// show an obvious "this is a test payment" confirmation before calling
// the complete endpoint.
export function createMockOrder({ amount, currency }) {
  return {
    gatewayOrderId: `mock_order_${crypto.randomBytes(8).toString("hex")}`,
    amount,
    currency,
  };
}
