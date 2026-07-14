import { Router } from "express";
import { z } from "zod";
import { connectDB } from "../lib/db/connect.js";
import User from "../models/User.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
import Media from "../models/Media.js";
import ActivityLog from "../models/ActivityLog.js";
import { requireSuperAdmin, notFound, clientIp } from "../lib/auth/guards.js";
import { parseJson, badRequest } from "../lib/apiError.js";
import { revokeAllSessionsForUser } from "../lib/auth/session.js";
import { logSecurityEvent } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

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
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const query = q
      ? { $or: [{ name: { $regex: q, $options: "i" } }, { email: { $regex: q, $options: "i" } }] }
      : {};

    const users = await User.find(query).sort({ createdAt: -1 }).limit(limit);

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

adminRouter.get(
  "/timelines",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const query = { deletedAt: null, ...(q ? { title: { $regex: q, $options: "i" } } : {}) };
    const timelines = await Timeline.find(query).sort({ createdAt: -1 }).limit(limit).populate("ownerId", "name email");

    const ids = timelines.map((t) => t._id);
    const [memberCounts, mediaCounts] = await Promise.all([
      Membership.aggregate([{ $match: { timelineId: { $in: ids }, status: "active" } }, { $group: { _id: "$timelineId", count: { $sum: 1 } } }]),
      Media.aggregate([{ $match: { timelineId: { $in: ids }, deletedAt: null } }, { $group: { _id: "$timelineId", count: { $sum: 1 } } }]),
    ]);
    const memberByTimeline = new Map(memberCounts.map((m) => [m._id.toString(), m.count]));
    const mediaByTimeline = new Map(mediaCounts.map((m) => [m._id.toString(), m.count]));

    res.json({
      timelines: timelines.map((t) => ({
        id: t._id.toString(),
        title: t.title,
        slug: t.slug,
        owner: t.ownerId ? { name: t.ownerId.name, email: t.ownerId.email } : null,
        memberCount: memberByTimeline.get(t._id.toString()) || 0,
        mediaCount: mediaByTimeline.get(t._id.toString()) || 0,
        createdAt: t.createdAt,
      })),
    });
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
    if (cursor) query.createdAt = { $lt: new Date(cursor) };

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
