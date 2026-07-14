import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { requireSuperAdmin } from "../lib/auth/guards.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const analyticsRouter = Router();

function daysParam(req, fallback = 30) {
  const raw = Number(req.query.days);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), 365);
}

analyticsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const days = daysParam(req);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await Order.aggregate([
      { $match: { status: "paid", paidAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$paidAt" } },
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
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const days = daysParam(req);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await User.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
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
    const admin = await requireSuperAdmin(req, res);
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
        user: o.userId ? { name: o.userId.name, email: o.userId.email } : null,
        plan: o.planId ? { name: o.planId.name, credits: o.planId.credits } : null,
        gatewayProvider: o.gatewayProvider,
        amount: o.amount,
        currency: o.currency,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
      })),
    });
  })
);
