import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import PaymentGateway from "../models/PaymentGateway.js";
import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { upsertGatewaySchema, checkoutSchema, verifyPaymentSchema } from "../lib/validation/payments.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requireSuperAdmin, getCurrentUser, unauthorized, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFeatureEnabled } from "../lib/featureFlags.js";
import { encryptSecret, decryptSecret, maskSecret, MASK_PREFIX } from "../lib/crypto.js";
import { createMockOrder } from "../lib/payments/mock.js";
import { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature } from "../lib/payments/razorpay.js";

export const paymentsRouter = Router();
export const publicPaymentsRouter = Router();

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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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

    const gateway = await PaymentGateway.findOne({ provider: data.gatewayProvider, isEnabled: true });
    if (!gateway) return badRequest(res, "This payment method is not available");

    const order = await Order.create({
      userId: user._id,
      planId: plan._id,
      gatewayProvider: gateway.provider,
      amount: plan.priceInPaise,
      currency: plan.currency,
      credits: plan.credits,
      status: "created",
    });

    try {
      if (gateway.provider === "mock") {
        const mockOrder = createMockOrder({ amount: plan.priceInPaise, currency: plan.currency });
        order.gatewayOrderId = mockOrder.gatewayOrderId;
        await order.save();
        return res.status(201).json({
          orderId: order._id.toString(),
          provider: "mock",
          gatewayOrderId: mockOrder.gatewayOrderId,
          amount: plan.priceInPaise,
          currency: plan.currency,
        });
      }

      if (gateway.provider === "razorpay") {
        const credentials = decryptCredentials(gateway.credentials);
        const rzOrder = await createRazorpayOrder({
          credentials,
          amount: plan.priceInPaise,
          currency: plan.currency,
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
      serverError(res, err, "Failed to start checkout");
    }
  })
);

paymentsRouter.post(
  "/mock/:orderId/complete",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const order = await Order.findOne({ _id: req.params.orderId, userId: user._id, gatewayProvider: "mock" });
    if (!order) return notFound(res, "Order not found");

    if (order.status === "paid") {
      const current = await User.findById(user._id);
      return res.json({ ok: true, alreadyPaid: true, credits: current.credits });
    }
    if (order.status !== "created") return badRequest(res, "This order can no longer be completed");

    order.status = "paid";
    order.gatewayPaymentId = `mock_pay_${order._id}`;
    order.paidAt = new Date();
    await order.save();

    const updatedUser = await User.findByIdAndUpdate(user._id, { $inc: { credits: order.credits } }, { new: true });
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
    const order = await Order.findOne({ _id: data.orderId, userId: user._id, gatewayProvider: "razorpay" });
    if (!order) return notFound(res, "Order not found");

    if (order.status === "paid") {
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

    order.status = "paid";
    order.gatewayPaymentId = data.razorpayPaymentId;
    order.paidAt = new Date();
    await order.save();

    const updatedUser = await User.findByIdAndUpdate(user._id, { $inc: { credits: order.credits } }, { new: true });
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
      const order = await Order.findOne({ gatewayOrderId: payment?.order_id, gatewayProvider: "razorpay" });
      if (order && order.status !== "paid") {
        order.status = "paid";
        order.gatewayPaymentId = payment.id;
        order.paidAt = new Date();
        order.metadata = { ...order.metadata, webhookEvent: event.event };
        await order.save();
        await User.findByIdAndUpdate(order.userId, { $inc: { credits: order.credits } });
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
        currency: o.currency,
        credits: o.credits,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
      })),
    });
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
