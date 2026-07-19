import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import PaymentGateway from "../models/PaymentGateway.js";
import PricingPlan from "../models/PricingPlan.js";
import Currency from "../models/Currency.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { upsertGatewaySchema, checkoutSchema, verifyPaymentSchema } from "../lib/validation/payments.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, getCurrentUser, unauthorized, notFound, clientIp } from "../lib/auth/guards.js";
import { logSecurityEvent } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFeatureEnabled } from "../lib/featureFlags.js";
import { encryptSecret, decryptSecret, maskSecret, MASK_PREFIX } from "../lib/crypto.js";
import { createMockOrder } from "../lib/payments/mock.js";
import {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  describeRazorpayError,
} from "../lib/payments/razorpay.js";
import Coupon from "../models/Coupon.js";
import { resolveCoupon, computeDiscount } from "./coupons.js";
import { sendTemplatedEmail } from "../lib/email/send.js";

// Redemptions are counted when an order actually gets paid, not at
// checkout-creation time — an abandoned or failed order shouldn't consume
// a limited coupon's redemption slot.
//
// The increment itself is the real enforcement point, not resolveCoupon's
// precheck at checkout: several concurrent checkouts can each observe
// redemptionCount < maxRedemptions and get a discounted order before any of
// them pays, so the cap can only actually be enforced here, atomically,
// against the live count. Returns ok:false (without incrementing) once the
// cap is reached instead of throwing — the order has already been charged
// by the time this runs, so the right response to an over-limit redemption
// is to flag it for the admin, not to fail a payment that already went
// through.
async function incrementCouponRedemption(couponCode) {
  if (!couponCode) return { ok: true };
  const updated = await Coupon.findOneAndUpdate(
    {
      code: couponCode,
      $or: [{ maxRedemptions: null }, { $expr: { $lt: ["$redemptionCount", "$maxRedemptions"] } }],
    },
    { $inc: { redemptionCount: 1 } }
  );
  return { ok: Boolean(updated) };
}

async function flagCouponOverLimit({ order, req }) {
  await logSecurityEvent({
    userId: order.userId,
    action: "coupon_redeemed_over_limit",
    ip: req ? clientIp(req) : null,
    metadata: { couponCode: order.couponCode, orderId: order._id.toString() },
  });
}

// Called from all three "an order just became paid" paths (mock complete,
// client-side verify, Razorpay webhook) — `updatedUser` should already
// reflect the post-credit balance (findByIdAndUpdate with { new: true }) so
// {total_credit} in the email is accurate.
async function sendPurchaseCompleteEmail(order, updatedUser) {
  const plan = await PricingPlan.findById(order.planId).select("name").lean();
  sendTemplatedEmail("purchase_complete", {
    user: updatedUser,
    vars: {
      plan_name: plan?.name || "Credits",
      credits_purchased: String(order.credits),
      amount_paid: (order.amount / 100).toFixed(2),
      currency: order.currency,
      order_id: order._id.toString(),
    },
  });
}

export const paymentsRouter = Router();
export const publicPaymentsRouter = Router();

// The mock gateway grants credits with no real payment — safe for local/
// test use, but a real financial-abuse risk if it's ever left enabled on a
// production deployment (whether by an admin's mistake or a compromised
// admin account). Hard-blocked here regardless of the admin `isEnabled`
// toggle, as a backstop beyond just remembering to keep it off.
function mockGatewayAllowed() {
  return process.env.NODE_ENV !== "production";
}

const KNOWN_PROVIDERS = ["razorpay", "phonepe", "upi", "mock"];

function decryptCredentials(encryptedCredentials = {}) {
  return Object.fromEntries(Object.entries(encryptedCredentials).map(([k, v]) => [k, decryptSecret(v)]));
}

function serializeGateway(gateway) {
  const decrypted = decryptCredentials(gateway.credentials);
  return {
    provider: gateway.provider,
    isEnabled: gateway.isEnabled,
    isDefault: gateway.isDefault,
    mode: gateway.mode,
    credentials: Object.fromEntries(Object.entries(decrypted).map(([k, v]) => [k, maskSecret(v)])),
    config: gateway.config,
    updatedAt: gateway.updatedAt,
  };
}

// ---- Gateways (admin) ----

paymentsRouter.get(
  "/gateways",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "commerce.gateways");
    if (!admin) return;
    await connectDB();
    const gateways = await PaymentGateway.find({});
    res.json({ gateways: gateways.map(serializeGateway) });
  })
);

paymentsRouter.put(
  "/gateways/:provider",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.gateways");
    if (!admin) return;

    const provider = req.params.provider;
    if (!KNOWN_PROVIDERS.includes(provider)) return badRequest(res, "Unknown payment provider");

    const data = parseJson(req, res, upsertGatewaySchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await PaymentGateway.findOne({ provider });
      const existingCredentials = existing?.credentials || {};

      // A masked value (e.g. "****7890") coming back from the admin UI means
      // "left unchanged" — re-encrypting the mask itself would corrupt the
      // real secret. Only values that don't look like our own mask format
      // get (re-)encrypted. An empty string means "no value" — skipped
      // entirely rather than encrypted, both because a blank field isn't a
      // secret worth storing and because encrypting zero bytes produces an
      // empty ciphertext segment indistinguishable from a malformed value.
      const mergedCredentials = {};
      for (const [key, value] of Object.entries(data.credentials)) {
        if (!value) continue;
        if (value.startsWith(MASK_PREFIX) && existingCredentials[key]) {
          mergedCredentials[key] = existingCredentials[key];
        } else {
          mergedCredentials[key] = encryptSecret(value);
        }
      }

      const gateway = await PaymentGateway.findOneAndUpdate(
        { provider },
        {
          $set: {
            isEnabled: data.isEnabled,
            isDefault: data.isDefault,
            mode: data.mode,
            credentials: mergedCredentials,
            config: data.config,
          },
        },
        { upsert: true, new: true }
      );

      if (data.isDefault) {
        await PaymentGateway.updateMany({ provider: { $ne: provider } }, { $set: { isDefault: false } });
      }

      res.json({ gateway: serializeGateway(gateway) });
    } catch (err) {
      serverError(res, err, "Failed to save payment gateway");
    }
  })
);

paymentsRouter.delete(
  "/gateways/:provider",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.gateways");
    if (!admin) return;

    await connectDB();
    const gateway = await PaymentGateway.findOneAndDelete({ provider: req.params.provider });
    if (!gateway) return notFound(res, "Gateway not found");
    res.json({ ok: true });
  })
);

// ---- Checkout / orders (authenticated users) ----

paymentsRouter.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    if (!(await isFeatureEnabled("pricing_page_enabled"))) {
      return res.status(403).json({ error: "Purchases are temporarily disabled", code: "FEATURE_DISABLED" });
    }

    const data = parseJson(req, res, checkoutSchema);
    if (!data) return;

    const plan = await PricingPlan.findOne({ _id: data.planId, isActive: true });
    if (!plan) return notFound(res, "Plan not found");

    const currency = await Currency.findOne({ code: data.currency, isEnabled: true });
    if (!currency) return badRequest(res, "This currency is not available");

    const planAmount = plan.prices.get(data.currency);
    if (planAmount == null) return badRequest(res, "This plan isn't priced in the selected currency");

    const gateway = await PaymentGateway.findOne({ provider: data.gatewayProvider, isEnabled: true });
    if (!gateway) return badRequest(res, "This payment method is not available");

    // Re-resolved server-side even though the pricing page already showed a
    // preview via /api/coupons/apply — never trust a client-supplied
    // discount amount.
    let finalAmount = planAmount;
    let discountAmount = 0;
    let couponCode = null;
    if (data.couponCode) {
      const result = await resolveCoupon(data.couponCode, plan._id.toString(), user);
      if (!result.ok) return badRequest(res, result.error);
      discountAmount = computeDiscount(result.coupon, planAmount);
      finalAmount = planAmount - discountAmount;
      couponCode = result.coupon.code;
    }

    const order = await Order.create({
      userId: user._id,
      planId: plan._id,
      gatewayProvider: gateway.provider,
      amount: finalAmount,
      originalAmount: discountAmount > 0 ? planAmount : null,
      couponCode,
      discountAmount,
      currency: data.currency,
      credits: plan.credits,
      status: "created",
    });

    try {
      if (gateway.provider === "mock") {
        if (!mockGatewayAllowed()) {
          order.status = "failed";
          await order.save();
          return badRequest(res, "This payment method is not available");
        }

        const mockOrder = createMockOrder({ amount: finalAmount, currency: data.currency });
        order.gatewayOrderId = mockOrder.gatewayOrderId;
        await order.save();
        return res.status(201).json({
          orderId: order._id.toString(),
          provider: "mock",
          gatewayOrderId: mockOrder.gatewayOrderId,
          amount: finalAmount,
          currency: data.currency,
        });
      }

      if (gateway.provider === "razorpay") {
        const credentials = decryptCredentials(gateway.credentials);
        const rzOrder = await createRazorpayOrder({
          credentials,
          amount: finalAmount,
          currency: data.currency,
          receipt: order._id.toString(),
        });
        order.gatewayOrderId = rzOrder.gatewayOrderId;
        await order.save();
        return res.status(201).json({
          orderId: order._id.toString(),
          provider: "razorpay",
          gatewayOrderId: rzOrder.gatewayOrderId,
          amount: rzOrder.amount,
          currency: rzOrder.currency,
          keyId: credentials.keyId,
        });
      }

      order.status = "failed";
      await order.save();
      return badRequest(res, `${gateway.provider} checkout isn't available yet`);
    } catch (err) {
      order.status = "failed";
      await order.save();

      // A rejection from the gateway itself (almost always a bad/mismatched
      // API key+secret pair) is the merchant's config problem, not ours —
      // surface the real reason and point back at where to fix it instead
      // of a generic 500 that gives the admin nothing to go on.
      const gatewayReason = describeRazorpayError(err);
      if (gatewayReason) {
        return badRequest(
          res,
          `The payment gateway rejected this request: ${gatewayReason}. Check the API key and secret under Payment gateways in the admin panel.`
        );
      }

      serverError(res, err, "Failed to start checkout");
    }
  })
);

paymentsRouter.post(
  "/mock/:orderId/complete",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    if (!mockGatewayAllowed()) return badRequest(res, "This payment method is not available");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const preCheck = await Order.findOne({ _id: req.params.orderId, userId: user._id, gatewayProvider: "mock" });
    if (!preCheck) return notFound(res, "Order not found");
    if (preCheck.status === "paid") {
      const current = await User.findById(user._id);
      return res.json({ ok: true, alreadyPaid: true, credits: current.credits });
    }
    if (preCheck.status !== "created") return badRequest(res, "This order can no longer be completed");

    // Atomic created -> paid transition: the status filter and the write
    // are one operation, so two concurrent completion requests for the
    // same order can't both pass the precheck above and both credit the
    // user's account.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.orderId, userId: user._id, gatewayProvider: "mock", status: "created" },
      { $set: { status: "paid", gatewayPaymentId: `mock_pay_${req.params.orderId}`, paidAt: new Date() } },
      { new: true }
    );
    if (!order) {
      const current = await User.findById(user._id);
      return res.json({ ok: true, alreadyPaid: true, credits: current.credits });
    }

    const redemption = await incrementCouponRedemption(order.couponCode);
    if (!redemption.ok) await flagCouponOverLimit({ order, req });

    const updatedUser = await User.findByIdAndUpdate(user._id, { $inc: { credits: order.credits } }, { new: true });
    sendPurchaseCompleteEmail(order, updatedUser);
    res.json({ ok: true, credits: updatedUser.credits });
  })
);

paymentsRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const data = parseJson(req, res, verifyPaymentSchema);
    if (!data) return;

    await connectDB();
    const preCheck = await Order.findOne({ _id: data.orderId, userId: user._id, gatewayProvider: "razorpay" });
    if (!preCheck) return notFound(res, "Order not found");

    if (preCheck.status === "paid") {
      const current = await User.findById(user._id);
      return res.json({ ok: true, alreadyPaid: true, credits: current.credits });
    }

    const gateway = await PaymentGateway.findOne({ provider: "razorpay" });
    if (!gateway) return badRequest(res, "Razorpay is not configured");
    const credentials = decryptCredentials(gateway.credentials);

    const valid = verifyPaymentSignature({
      keySecret: credentials.keySecret,
      razorpayOrderId: data.razorpayOrderId,
      razorpayPaymentId: data.razorpayPaymentId,
      razorpaySignature: data.razorpaySignature,
    });
    if (!valid) return badRequest(res, "Payment signature verification failed");

    // Atomic status transition, guarding against this request racing the
    // Razorpay webhook for the same order — only whichever of the two
    // actually flips status first credits the user; the loser just reports
    // the order as already paid.
    const order = await Order.findOneAndUpdate(
      { _id: data.orderId, userId: user._id, gatewayProvider: "razorpay", status: { $ne: "paid" } },
      { $set: { status: "paid", gatewayPaymentId: data.razorpayPaymentId, paidAt: new Date() } },
      { new: true }
    );
    if (!order) {
      const current = await User.findById(user._id);
      return res.json({ ok: true, alreadyPaid: true, credits: current.credits });
    }

    const redemption = await incrementCouponRedemption(order.couponCode);
    if (!redemption.ok) await flagCouponOverLimit({ order, req });

    const updatedUser = await User.findByIdAndUpdate(user._id, { $inc: { credits: order.credits } }, { new: true });
    sendPurchaseCompleteEmail(order, updatedUser);
    res.json({ ok: true, credits: updatedUser.credits });
  })
);

// No verifyCsrf: Razorpay's servers call this directly (no browser, no
// cookies, no Origin header) — authenticity is established purely via the
// HMAC signature header instead.
paymentsRouter.post(
  "/webhook/razorpay",
  asyncHandler(async (req, res) => {
    await connectDB();
    const gateway = await PaymentGateway.findOne({ provider: "razorpay" });
    const webhookSecret = gateway ? decryptCredentials(gateway.credentials).webhookSecret : null;
    if (!webhookSecret) return res.status(400).json({ error: "Razorpay webhook secret not configured" });

    const signature = req.headers["x-razorpay-signature"];
    const valid = verifyWebhookSignature({ webhookSecret, rawBody: req.rawBody, signature });
    if (!valid) return res.status(400).json({ error: "Invalid webhook signature" });

    const event = req.body;
    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      // Atomic status transition — guards this against racing the
      // client-side /verify call for the same order, which can otherwise
      // credit the user twice (see /verify's matching comment above).
      const order = await Order.findOneAndUpdate(
        { gatewayOrderId: payment?.order_id, gatewayProvider: "razorpay", status: { $ne: "paid" } },
        {
          $set: {
            status: "paid",
            gatewayPaymentId: payment?.id,
            paidAt: new Date(),
            "metadata.webhookEvent": event.event,
          },
        },
        { new: true }
      );
      if (order) {
        const redemption = await incrementCouponRedemption(order.couponCode);
        if (!redemption.ok) await flagCouponOverLimit({ order, req });
        const updatedUser = await User.findByIdAndUpdate(order.userId, { $inc: { credits: order.credits } }, { new: true });
        sendPurchaseCompleteEmail(order, updatedUser);
      }
    }

    res.json({ ok: true });
  })
);

paymentsRouter.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const orders = await Order.find({ userId: user._id }).sort({ createdAt: -1 }).populate("planId", "name credits");

    res.json({
      orders: orders.map((o) => ({
        id: o._id.toString(),
        plan: o.planId ? { name: o.planId.name, credits: o.planId.credits } : null,
        gatewayProvider: o.gatewayProvider,
        amount: o.amount,
        originalAmount: o.originalAmount,
        couponCode: o.couponCode,
        discountAmount: o.discountAmount,
        currency: o.currency,
        credits: o.credits,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
      })),
    });
  })
);

// ---- Refunds (admin) ----
// Bookkeeping-only: reverses the credits an order granted, it does not call
// out to the payment gateway to actually return money. Real gateway refunds
// (Razorpay's refund API etc.) need a merchant-side decision per provider
// this app doesn't make on its own — this just keeps the ledger honest once
// that's been handled elsewhere.

paymentsRouter.post(
  "/orders/:id/refund",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.orders");
    if (!admin) return;

    await connectDB();
    // Atomic paid -> refunded transition: guards against a double-submit
    // (or two admins refunding the same order at once) both passing the
    // status check and both deducting credits from the user.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, status: "paid" },
      { $set: { status: "refunded", refundedAt: new Date() } },
      { new: true }
    );
    if (!order) {
      const existing = await Order.findById(req.params.id);
      if (!existing) return notFound(res, "Order not found");
      return badRequest(res, "Only a paid order can be refunded");
    }

    // Aggregation-pipeline update clamps to zero atomically in the same
    // operation as the read, instead of a separate read-Math.max-write that
    // could race a concurrent credit grant/spend on the same account.
    await User.findByIdAndUpdate(order.userId, [
      { $set: { credits: { $max: [0, { $subtract: ["$credits", order.credits] }] } } },
    ]);

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_refunded_order",
      ip: clientIp(req),
      metadata: { orderId: order._id.toString(), targetUserId: order.userId.toString(), credits: order.credits },
    });

    res.json({ ok: true, order: { id: order._id.toString(), status: order.status, refundedAt: order.refundedAt } });
  })
);

// ---- Public ----

publicPaymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const gateways = await PaymentGateway.find({ isEnabled: true });
    res.json({ gateways: gateways.map((g) => ({ provider: g.provider, isDefault: g.isDefault })) });
  })
);
