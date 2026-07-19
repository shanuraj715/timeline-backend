import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { requirePermission } from "../lib/auth/guards.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const analyticsRouter = Router();

function daysParam(req, fallback = 30) {
  const raw = Number(req.query.days);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), 365);
}

// Resolves the query window: an explicit ?from=&to= range (used for the
// "custom", "monthly", and "yearly" presets) takes priority over the older
// ?days= rolling-window param (still used by the 7/30/90-day presets).
// groupBy controls date bucketing — "month" for longer ranges where a daily
// point-per-day would be too dense to read.
function rangeParams(req, fallback = 30) {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const groupBy = req.query.groupBy === "month" ? "month" : "day";

  if (from instanceof Date && !isNaN(from) && to instanceof Date && !isNaN(to)) {
    return { since: from, until: to, groupBy };
  }

  const days = daysParam(req, fallback);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000), until: new Date(), groupBy };
}

const DATE_FORMAT = { day: "%Y-%m-%d", month: "%Y-%m" };

analyticsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "dashboard");
    if (!admin) return;

    await connectDB();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [revenueAgg, userCount, recentSignups] = await Promise.all([
      Order.aggregate([
        { $match: { status: "paid" } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$amount" },
            totalOrders: { $sum: 1 },
            totalCreditsSold: { $sum: "$credits" },
          },
        },
      ]),
      User.countDocuments({}),
      User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    ]);

    const stats = revenueAgg[0] || { totalRevenue: 0, totalOrders: 0, totalCreditsSold: 0 };
    const avgOrderValue = stats.totalOrders > 0 ? Math.round(stats.totalRevenue / stats.totalOrders) : 0;

    res.json({
      totalRevenue: stats.totalRevenue,
      totalOrders: stats.totalOrders,
      totalCreditsSold: stats.totalCreditsSold,
      avgOrderValue,
      totalUsers: userCount,
      newUsersLast30Days: recentSignups,
    });
  })
);

analyticsRouter.get(
  "/revenue-over-time",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "dashboard");
    if (!admin) return;

    await connectDB();
    const { since, until, groupBy } = rangeParams(req);

    const rows = await Order.aggregate([
      { $match: { status: "paid", paidAt: { $gte: since, $lte: until } } },
      {
        $group: {
          _id: { $dateToString: { format: DATE_FORMAT[groupBy], date: "$paidAt" } },
          revenue: { $sum: "$amount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ points: rows.map((r) => ({ date: r._id, revenue: r.revenue, orders: r.orders })) });
  })
);

analyticsRouter.get(
  "/signups-over-time",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "dashboard");
    if (!admin) return;

    await connectDB();
    const { since, until, groupBy } = rangeParams(req);

    const rows = await User.aggregate([
      { $match: { createdAt: { $gte: since, $lte: until } } },
      {
        $group: {
          _id: { $dateToString: { format: DATE_FORMAT[groupBy], date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ points: rows.map((r) => ({ date: r._id, count: r.count })) });
  })
);

analyticsRouter.get(
  "/recent-orders",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "dashboard");
    if (!admin) return;

    await connectDB();
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("userId", "name email")
      .populate("planId", "name credits");

    res.json({
      orders: orders.map((o) => ({
        id: o._id.toString(),
        user: o.userId ? { id: o.userId._id.toString(), name: o.userId.name, email: o.userId.email } : null,
        plan: o.planId ? { name: o.planId.name, credits: o.planId.credits } : null,
        gatewayProvider: o.gatewayProvider,
        amount: o.amount,
        currency: o.currency,
        credits: o.credits,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        refundedAt: o.refundedAt,
      })),
    });
  })
);
