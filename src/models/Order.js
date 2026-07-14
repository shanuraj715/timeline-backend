import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Doubles as the credit purchase transaction/ledger — every successful
// order corresponds to exactly one credit top-up, so a separate ledger
// collection would just duplicate this data.
const OrderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: "PricingPlan", required: true },
    gatewayProvider: { type: String, enum: ["razorpay", "phonepe", "upi", "mock"], required: true },
    gatewayOrderId: { type: String, default: null },
    gatewayPaymentId: { type: String, default: null },
    amount: { type: Number, required: true }, // paise, after any coupon discount — what's actually charged
    originalAmount: { type: Number, default: null }, // paise, pre-discount — null when no coupon was used
    currency: { type: String, default: "INR" },
    credits: { type: Number, required: true },
    couponCode: { type: String, default: null },
    discountAmount: { type: Number, default: 0 }, // paise
    status: {
      type: String,
      enum: ["created", "paid", "failed", "cancelled", "refunded"],
      default: "created",
      index: true,
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ userId: 1, createdAt: -1 });

export default models.Order || model("Order", OrderSchema);
