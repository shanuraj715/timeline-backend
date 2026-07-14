import { Router } from "express";
import { z } from "zod";
import { connectDB } from "../lib/db/connect.js";
import User from "../models/User.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
import Media from "../models/Media.js";
import ActivityLog from "../models/ActivityLog.js";
import Order from "../models/Order.js";
import { requireSuperAdmin, notFound, clientIp } from "../lib/auth/guards.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { revokeAllSessionsForUser } from "../lib/auth/session.js";
import { logSecurityEvent } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getPlatformSettings } from "../lib/platformSettings.js";
import { getTimelineUsedBytes } from "../lib/storageQuota.js";

export const adminRouter = Router();

adminRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();

    const [userCount, timelineCount, mediaCount, storageBytes, lockedCount] = await Promise.all([
      User.countDocuments({}),
      Timeline.countDocuments({ deletedAt: null }),
      Media.countDocuments({ deletedAt: null }),
      Media.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: null, total: { $sum: "$size" } } }]),
      User.countDocuments({ lockUntil: { $gt: new Date() } }),
    ]);

    res.json({
      userCount,
      timelineCount,
      mediaCount,
      storageBytes: storageBytes[0]?.total || 0,
      lockedAccountCount: lockedCount,
    });
  })
);

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const query = q
      ? { $or: [{ name: { $regex: q, $options: "i" } }, { email: { $regex: q, $options: "i" } }] }
      : {};

    const [users, total] = await Promise.all([
      User.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(query),
    ]);

    res.json({
      users: users.map((u) => ({
        id: u._id.toString(),
        name: u.name,
        email: u.email,
        role: u.role,
        credits: u.credits,
        isLocked: u.isLocked(),
        lockUntil: u.lockUntil,
        failedLoginAttempts: u.failedLoginAttempts,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      })),
      total,
      page,
      limit,
    });
  })
);

const patchUserSchema = z.object({
  action: z.enum(["unlock", "promote", "demote"]),
});

adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const data = parseJson(req, res, patchUserSchema);
    if (!data) return;

    const target = await User.findById(id);
    if (!target) return notFound(res, "User not found");

    const ip = clientIp(req);

    if (data.action === "unlock") {
      target.failedLoginAttempts = 0;
      target.lockLevel = 0;
      target.lockUntil = null;
      await target.save();
      await logSecurityEvent({ userId: admin._id, action: "admin_unlocked_account", ip, metadata: { targetUserId: id } });
    } else if (data.action === "promote") {
      target.role = "superadmin";
      await target.save();
      await logSecurityEvent({ userId: admin._id, action: "admin_promoted_user", ip, metadata: { targetUserId: id } });
    } else if (data.action === "demote") {
      if (target._id.equals(admin._id)) return badRequest(res, "You can't demote your own account");
      target.role = "user";
      await target.save();
      await revokeAllSessionsForUser(target._id, "demoted_by_admin");
      await logSecurityEvent({ userId: admin._id, action: "admin_demoted_user", ip, metadata: { targetUserId: id } });
    }

    res.json({ ok: true, role: target.role, isLocked: target.isLocked() });
  })
);

const adjustCreditsSchema = z.object({
  amount: z.number().int().refine((v) => v !== 0, "Amount can't be zero"),
  reason: z.string().trim().max(300).default(""),
});

adminRouter.post(
  "/users/:id/credits",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const data = parseJson(req, res, adjustCreditsSchema);
    if (!data) return;

    const target = await User.findById(id);
    if (!target) return notFound(res, "User not found");

    target.credits = Math.max(0, target.credits + data.amount);
    await target.save();

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_adjusted_credits",
      ip: clientIp(req),
      metadata: { targetUserId: id, amount: data.amount, reason: data.reason, balanceAfter: target.credits },
    });

    res.json({ ok: true, credits: target.credits });
  })
);

// Deliberately anonymized: no title, slug, description, cover image, or
// owner identity — just enough structural metadata (role, size, activity)
// for support/moderation without exposing what's actually in someone's
// private photo timeline or being able to find/open it. The full-detail
// /timelines list above is a different, broader-scoped view.
adminRouter.get(
  "/users/:id/timelines",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const target = await User.findById(id);
    if (!target) return notFound(res, "User not found");

    const memberships = await Membership.find({ userId: id, status: "active" }).lean();
    const timelineIds = memberships.map((m) => m.timelineId);
    const roleByTimeline = new Map(memberships.map((m) => [m.timelineId.toString(), m.role]));

    const timelines = await Timeline.find({ _id: { $in: timelineIds }, deletedAt: null })
      .select("_id purchasedStorageBytes createdAt updatedAt")
      .lean();

    const ids = timelines.map((t) => t._id);
    const [memberCounts, mediaCounts, storageBytes, settings] = await Promise.all([
      Membership.aggregate([{ $match: { timelineId: { $in: ids }, status: "active" } }, { $group: { _id: "$timelineId", count: { $sum: 1 } } }]),
      Media.aggregate([{ $match: { timelineId: { $in: ids }, deletedAt: null } }, { $group: { _id: "$timelineId", count: { $sum: 1 } } }]),
      Media.aggregate([{ $match: { timelineId: { $in: ids }, deletedAt: null } }, { $group: { _id: "$timelineId", total: { $sum: "$size" } } }]),
      getPlatformSettings(),
    ]);
    const memberByTimeline = new Map(memberCounts.map((m) => [m._id.toString(), m.count]));
    const mediaByTimeline = new Map(mediaCounts.map((m) => [m._id.toString(), m.count]));
    const usedByTimeline = new Map(storageBytes.map((s) => [s._id.toString(), s.total]));

    res.json({
      timelines: timelines.map((t) => ({
        id: t._id.toString(),
        role: roleByTimeline.get(t._id.toString()) || "unknown",
        memberCount: memberByTimeline.get(t._id.toString()) || 0,
        mediaCount: mediaByTimeline.get(t._id.toString()) || 0,
        usedBytes: usedByTimeline.get(t._id.toString()) || 0,
        quotaBytes: settings.freeStorageBytesPerTimeline + (t.purchasedStorageBytes || 0),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    });
  })
);

adminRouter.get(
  "/timelines",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const query = { deletedAt: null, ...(q ? { title: { $regex: q, $options: "i" } } : {}) };
    const [timelines, total] = await Promise.all([
      Timeline.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("ownerId", "name email"),
      Timeline.countDocuments(query),
    ]);

    const ids = timelines.map((t) => t._id);
    const [memberCounts, mediaCounts, storageBytes, settings] = await Promise.all([
      Membership.aggregate([{ $match: { timelineId: { $in: ids }, status: "active" } }, { $group: { _id: "$timelineId", count: { $sum: 1 } } }]),
      Media.aggregate([{ $match: { timelineId: { $in: ids }, deletedAt: null } }, { $group: { _id: "$timelineId", count: { $sum: 1 } } }]),
      Media.aggregate([{ $match: { timelineId: { $in: ids }, deletedAt: null } }, { $group: { _id: "$timelineId", total: { $sum: "$size" } } }]),
      getPlatformSettings(),
    ]);
    const memberByTimeline = new Map(memberCounts.map((m) => [m._id.toString(), m.count]));
    const mediaByTimeline = new Map(mediaCounts.map((m) => [m._id.toString(), m.count]));
    const usedByTimeline = new Map(storageBytes.map((s) => [s._id.toString(), s.total]));

    res.json({
      timelines: timelines.map((t) => ({
        id: t._id.toString(),
        title: t.title,
        slug: t.slug,
        owner: t.ownerId ? { name: t.ownerId.name, email: t.ownerId.email } : null,
        memberCount: memberByTimeline.get(t._id.toString()) || 0,
        mediaCount: mediaByTimeline.get(t._id.toString()) || 0,
        usedBytes: usedByTimeline.get(t._id.toString()) || 0,
        quotaBytes: settings.freeStorageBytesPerTimeline + (t.purchasedStorageBytes || 0),
        createdAt: t.createdAt,
      })),
      total,
      page,
      limit,
    });
  })
);

const updateTimelineStorageSchema = z.object({
  quotaBytes: z.number().int().min(0),
});

adminRouter.patch(
  "/timelines/:id/storage",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const data = parseJson(req, res, updateTimelineStorageSchema);
    if (!data) return;

    const timeline = await Timeline.findById(id);
    if (!timeline) return notFound(res, "Timeline not found");

    try {
      const [usedBytes, settings] = await Promise.all([getTimelineUsedBytes(timeline._id), getPlatformSettings()]);

      // The one rule that actually matters here — everything else about the
      // number is the admin's call, including going below the site-wide
      // free default for this one timeline.
      if (data.quotaBytes < usedBytes) {
        return badRequest(
          res,
          `Quota can't be set below what's already used (${(usedBytes / (1024 * 1024)).toFixed(1)} MB).`
        );
      }

      timeline.purchasedStorageBytes = data.quotaBytes - settings.freeStorageBytesPerTimeline;
      await timeline.save();

      await logSecurityEvent({
        userId: admin._id,
        action: "admin_set_timeline_storage_quota",
        ip: clientIp(req),
        metadata: { timelineId: id, quotaBytes: data.quotaBytes },
      });

      res.json({ ok: true, usedBytes, quotaBytes: data.quotaBytes });
    } catch (err) {
      serverError(res, err, "Failed to update storage quota");
    }
  })
);

// Superseded the analytics/recent-orders route for this table — that one
// is still used as-is for the small "recent activity" dashboard widget,
// but it hard-caps at 50 rows with no way to page further, which doesn't
// work for a full transaction list that only grows over time.
adminRouter.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const status = typeof req.query.status === "string" ? req.query.status.trim() : undefined;

    const query = status && status !== "all" ? { status } : {};

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("userId", "name email")
        .populate("planId", "name credits"),
      Order.countDocuments(query),
    ]);

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
      total,
      page,
      limit,
    });
  })
);

// Distinct actions for the filter dropdown — derived from real data instead
// of a hardcoded list, so a newly-added logSecurityEvent() action shows up
// here automatically instead of needing this route updated too.
adminRouter.get(
  "/security-log/actions",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const actions = await ActivityLog.distinct("action", { kind: "security" });
    res.json({ actions: actions.sort() });
  })
);

adminRouter.get(
  "/security-log",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const cursor = req.query.cursor;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const query = { kind: "security" };

    const createdAt = {};
    if (cursor) createdAt.$lt = new Date(cursor);
    if (req.query.dateFrom) createdAt.$gte = new Date(req.query.dateFrom);
    if (req.query.dateTo) createdAt.$lte = new Date(req.query.dateTo);
    if (Object.keys(createdAt).length > 0) query.createdAt = createdAt;

    if (typeof req.query.action === "string" && req.query.action.trim()) {
      query.action = req.query.action.trim();
    }
    if (typeof req.query.ip === "string" && req.query.ip.trim()) {
      query.ip = { $regex: req.query.ip.trim(), $options: "i" };
    }
    if (typeof req.query.userEmail === "string" && req.query.userEmail.trim()) {
      const matchingUsers = await User.find({
        $or: [
          { name: { $regex: req.query.userEmail.trim(), $options: "i" } },
          { email: { $regex: req.query.userEmail.trim(), $options: "i" } },
        ],
      }).select("_id");
      // No match still needs to produce an empty result set, not "no filter" —
      // an id no real ActivityLog row will ever have.
      query.userId = { $in: matchingUsers.length > 0 ? matchingUsers.map((u) => u._id) : [null] };
    }

    const entries = await ActivityLog.find(query).sort({ createdAt: -1 }).limit(limit + 1).populate("userId", "name email");
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;

    res.json({
      events: page.map((e) => ({
        id: e._id.toString(),
        action: e.action,
        user: e.userId ? { name: e.userId.name, email: e.userId.email } : null,
        ip: e.ip,
        userAgent: e.userAgent,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    });
  })
);
