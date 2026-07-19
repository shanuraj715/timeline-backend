import { Router } from "express";
import { z } from "zod";
import { connectDB } from "../lib/db/connect.js";
import { escapeRegex } from "../lib/escapeRegex.js";
import User from "../models/User.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
import Media from "../models/Media.js";
import ActivityLog from "../models/ActivityLog.js";
import Order from "../models/Order.js";
import { requirePermission, notFound, clientIp } from "../lib/auth/guards.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { logSecurityEvent } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { revokeAllSessionsForUser } from "../lib/auth/session.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getPlatformSettings } from "../lib/platformSettings.js";
import { getTimelineUsedBytes } from "../lib/storageQuota.js";
import { sendTemplatedEmail } from "../lib/email/send.js";

export const adminRouter = Router();

// Shared by every `?format=csv` export below. Quotes a field only when it
// needs it (contains a comma, quote, or newline), doubling embedded quotes —
// standard RFC 4180 escaping.
function csvField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows, columns) {
  const lines = rows.map((row) => columns.map((col) => csvField(row[col])).join(","));
  return [columns.join(","), ...lines].join("\n");
}

adminRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "dashboard");
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
    const admin = await requirePermission(req, res, "platform.users");
    if (!admin) return;

    await connectDB();
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const query = q
      ? { $or: [{ name: { $regex: escapeRegex(q), $options: "i" } }, { email: { $regex: escapeRegex(q), $options: "i" } }] }
      : {};

    const toRow = (u) => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      role: u.role,
      credits: u.credits,
      dob: u.dob ? u.dob.toISOString() : "",
      gender: u.gender,
      phone: u.phone,
      country: u.country,
      isLocked: u.isLocked(),
      lockUntil: u.lockUntil ? u.lockUntil.toISOString() : "",
      failedLoginAttempts: u.failedLoginAttempts,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : "",
      createdAt: u.createdAt.toISOString(),
    });

    // CSV export skips pagination entirely (a full-list download, not a
    // page of one) but keeps a hard ceiling so a huge table can't be turned
    // into an unbounded query.
    if (req.query.format === "csv") {
      const users = await User.find(query).sort({ createdAt: -1 }).limit(10000);
      const csv = toCsv(
        users.map(toRow),
        ["id", "name", "email", "role", "credits", "dob", "gender", "phone", "country", "isLocked", "lockUntil", "failedLoginAttempts", "lastLoginAt", "createdAt"]
      );
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="users-export.csv"');
      return res.send(csv);
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(query),
    ]);

    res.json({
      users: users.map(toRow),
      total,
      page,
      limit,
    });
  })
);

// Just "unlock" now — role/permission changes moved to routes/adminAccounts.js,
// which carries its own grant-scope and peer-protection rules that don't
// belong mixed into plain customer-account moderation.
const patchUserSchema = z.object({
  action: z.literal("unlock"),
});

// Shared with the /users/bulk "unlock" action below.
async function unlockUser(target) {
  target.failedLoginAttempts = 0;
  target.lockLevel = 0;
  target.lockUntil = null;
  await target.save();
}

adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.users");
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const data = parseJson(req, res, patchUserSchema);
    if (!data) return;

    const target = await User.findById(id);
    if (!target) return notFound(res, "User not found");

    const ip = clientIp(req);

    await unlockUser(target);
    await logSecurityEvent({ userId: admin._id, action: "admin_unlocked_account", ip, metadata: { targetUserId: id } });

    res.json({ ok: true, role: target.role, isLocked: target.isLocked() });
  })
);

const reasonSchema = z.object({ reason: z.string().trim().max(300).optional() });

// Shared with the /users/bulk "ban"/"unban"/"force-logout" actions below.
// Returns { alreadyBanned } so callers (single-item and bulk) can both
// decide whether to treat the call as a no-op.
async function banUser(target, reason) {
  if (target.banned) return { alreadyBanned: true };
  target.banned = true;
  target.bannedAt = new Date();
  target.bannedReason = reason || null;
  await target.save();
  await revokeAllSessionsForUser(target._id, "admin_banned");
  return { alreadyBanned: false };
}

async function unbanUser(target) {
  target.banned = false;
  target.bannedAt = null;
  target.bannedReason = null;
  await target.save();
}

async function forceLogoutUser(target) {
  await revokeAllSessionsForUser(target._id, "admin_forced_logout");
}

adminRouter.post(
  "/users/:id/ban",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.users");
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const data = parseJson(req, res, reasonSchema);
    if (!data) return;

    const target = await User.findById(id);
    if (!target) return notFound(res, "User not found");

    const { alreadyBanned } = await banUser(target, data.reason);
    if (alreadyBanned) return res.json({ ok: true, alreadyBanned: true });

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_banned_user",
      ip: clientIp(req),
      metadata: { targetUserId: id, reason: data.reason || null },
    });

    res.json({ ok: true, banned: true });
  })
);

adminRouter.post(
  "/users/:id/unban",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.users");
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const target = await User.findById(id);
    if (!target) return notFound(res, "User not found");

    await unbanUser(target);
    await logSecurityEvent({ userId: admin._id, action: "admin_unbanned_user", ip: clientIp(req), metadata: { targetUserId: id } });

    res.json({ ok: true, banned: false });
  })
);

adminRouter.post(
  "/users/:id/force-logout",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.users");
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const target = await User.findById(id);
    if (!target) return notFound(res, "User not found");

    await forceLogoutUser(target);
    await logSecurityEvent({ userId: admin._id, action: "admin_forced_logout", ip: clientIp(req), metadata: { targetUserId: id } });

    res.json({ ok: true });
  })
);

const bulkUserActionSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
  action: z.enum(["unlock", "ban", "unban", "force-logout"]),
});

adminRouter.post(
  "/users/bulk",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.users");
    if (!admin) return;

    await connectDB();

    const data = parseJson(req, res, bulkUserActionSchema);
    if (!data) return;

    let succeeded = 0;
    let failed = 0;

    for (const id of data.ids) {
      const target = await User.findById(id);
      if (!target) {
        failed++;
        continue;
      }

      switch (data.action) {
        case "unlock":
          await unlockUser(target);
          break;
        case "ban":
          await banUser(target, undefined);
          break;
        case "unban":
          await unbanUser(target);
          break;
        case "force-logout":
          await forceLogoutUser(target);
          break;
      }
      succeeded++;
    }

    // One aggregated event for the whole batch rather than one per row —
    // the per-id detail still lives in the metadata for anyone auditing it.
    await logSecurityEvent({
      userId: admin._id,
      action: "admin_bulk_user_action",
      ip: clientIp(req),
      metadata: { action: data.action, ids: data.ids, succeeded, failed },
    });

    res.json({ ok: true, succeeded, failed });
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

    const admin = await requirePermission(req, res, "platform.users");
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

    // Only on a grant, not a deduction — "credits_added" has nothing
    // meaningful to say about a balance going down.
    if (data.amount > 0) {
      sendTemplatedEmail("credits_added", {
        user: target,
        vars: { credits_amount: String(data.amount), credit_reason: data.reason || "" },
      });
    }

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
    const admin = await requirePermission(req, res, "platform.users");
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

// Shared between the paginated JSON list and the CSV export below — both
// need the same member/media/storage aggregates keyed off the same page of
// timeline ids, just rendered differently at the end.
async function timelineRows(timelines) {
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

  return timelines.map((t) => ({
    id: t._id.toString(),
    title: t.title,
    slug: t.slug,
    owner: t.ownerId ? { name: t.ownerId.name, email: t.ownerId.email } : null,
    memberCount: memberByTimeline.get(t._id.toString()) || 0,
    mediaCount: mediaByTimeline.get(t._id.toString()) || 0,
    usedBytes: usedByTimeline.get(t._id.toString()) || 0,
    quotaBytes: settings.freeStorageBytesPerTimeline + (t.purchasedStorageBytes || 0),
    createdAt: t.createdAt,
  }));
}

adminRouter.get(
  "/timelines",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.timelines");
    if (!admin) return;

    await connectDB();
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const query = { deletedAt: null, ...(q ? { title: { $regex: escapeRegex(q), $options: "i" } } : {}) };

    if (req.query.format === "csv") {
      const timelines = await Timeline.find(query).sort({ createdAt: -1 }).limit(10000).populate("ownerId", "name email");
      const rows = await timelineRows(timelines);
      const csv = toCsv(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          slug: r.slug,
          owner_name: r.owner?.name || "",
          owner_email: r.owner?.email || "",
          memberCount: r.memberCount,
          mediaCount: r.mediaCount,
          usedBytes: r.usedBytes,
          quotaBytes: r.quotaBytes,
          createdAt: r.createdAt.toISOString(),
        })),
        ["id", "title", "slug", "owner_name", "owner_email", "memberCount", "mediaCount", "usedBytes", "quotaBytes", "createdAt"]
      );
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="timelines-export.csv"');
      return res.send(csv);
    }

    const [timelines, total] = await Promise.all([
      Timeline.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("ownerId", "name email"),
      Timeline.countDocuments(query),
    ]);

    res.json({
      timelines: await timelineRows(timelines),
      total,
      page,
      limit,
    });
  })
);

const suspendTimelineSchema = z.object({ reason: z.string().trim().max(300).optional() });

// Suspend/restore just piggyback on the existing `deletedAt` soft-delete —
// every read path in the app already filters `deletedAt: null`, so setting
// it here hides the timeline everywhere (dashboard, sharing, API) without
// needing a second "suspended" flag threaded through all those call sites.
async function suspendTimeline(timeline) {
  if (timeline.deletedAt) return { alreadySuspended: true };
  timeline.deletedAt = new Date();
  await timeline.save();
  return { alreadySuspended: false };
}

async function restoreTimeline(timeline) {
  if (!timeline.deletedAt) return { alreadyActive: true };
  timeline.deletedAt = null;
  await timeline.save();
  return { alreadyActive: false };
}

adminRouter.post(
  "/timelines/:id/suspend",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.timelines");
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const data = parseJson(req, res, suspendTimelineSchema);
    if (!data) return;

    const timeline = await Timeline.findById(id);
    if (!timeline) return notFound(res, "Timeline not found");

    const { alreadySuspended } = await suspendTimeline(timeline);
    if (alreadySuspended) return res.json({ ok: true, alreadySuspended: true });

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_suspended_timeline",
      ip: clientIp(req),
      metadata: { timelineId: id, reason: data.reason || null },
    });

    res.json({ ok: true });
  })
);

adminRouter.post(
  "/timelines/:id/restore",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.timelines");
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const timeline = await Timeline.findById(id);
    if (!timeline) return notFound(res, "Timeline not found");

    const { alreadyActive } = await restoreTimeline(timeline);
    if (alreadyActive) return res.json({ ok: true, alreadyActive: true });

    await logSecurityEvent({ userId: admin._id, action: "admin_restored_timeline", ip: clientIp(req), metadata: { timelineId: id } });

    res.json({ ok: true });
  })
);

const transferOwnershipSchema = z.object({
  newOwnerUserId: z.string(),
});

adminRouter.post(
  "/timelines/:id/transfer-ownership",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.timelines");
    if (!admin) return;

    const { id } = req.params;
    await connectDB();

    const data = parseJson(req, res, transferOwnershipSchema);
    if (!data) return;

    const timeline = await Timeline.findById(id);
    if (!timeline) return notFound(res, "Timeline not found");

    const newOwner = await User.findById(data.newOwnerUserId);
    if (!newOwner) return badRequest(res, "User not found");

    if (data.newOwnerUserId === timeline.ownerId.toString()) {
      return badRequest(res, "This user already owns this timeline");
    }

    const previousOwnerId = timeline.ownerId.toString();

    await Membership.findOneAndUpdate(
      { timelineId: timeline._id, userId: newOwner._id },
      { $set: { role: "owner", status: "active" } },
      { upsert: true, new: true }
    );
    // Fine if the previous owner has no membership row to demote (shouldn't
    // normally happen, but not worth failing the transfer over).
    await Membership.updateOne({ timelineId: timeline._id, userId: timeline.ownerId }, { $set: { role: "admin" } });

    timeline.ownerId = newOwner._id;
    await timeline.save();

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_transferred_timeline_ownership",
      ip: clientIp(req),
      metadata: { timelineId: id, previousOwnerId, newOwnerId: data.newOwnerUserId },
    });

    res.json({ ok: true });
  })
);

const bulkTimelineActionSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
  action: z.enum(["suspend", "restore"]),
});

adminRouter.post(
  "/timelines/bulk",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.timelines");
    if (!admin) return;

    await connectDB();

    const data = parseJson(req, res, bulkTimelineActionSchema);
    if (!data) return;

    let succeeded = 0;
    let failed = 0;

    for (const id of data.ids) {
      const timeline = await Timeline.findById(id);
      if (!timeline) {
        failed++;
        continue;
      }

      if (data.action === "suspend") {
        await suspendTimeline(timeline);
      } else {
        await restoreTimeline(timeline);
      }
      succeeded++;
    }

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_bulk_timeline_action",
      ip: clientIp(req),
      metadata: { action: data.action, ids: data.ids, succeeded, failed },
    });

    res.json({ ok: true, succeeded, failed });
  })
);

const updateTimelineStorageSchema = z.object({
  quotaBytes: z.number().int().min(0),
});

adminRouter.patch(
  "/timelines/:id/storage",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.timelines");
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
    const admin = await requirePermission(req, res, "commerce.orders");
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
    const admin = await requirePermission(req, res, "platform.security");
    if (!admin) return;

    await connectDB();
    const actions = await ActivityLog.distinct("action", { kind: "security" });
    res.json({ actions: actions.sort() });
  })
);

adminRouter.get(
  "/security-log",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.security");
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
      query.ip = { $regex: escapeRegex(req.query.ip.trim()), $options: "i" };
    }
    if (typeof req.query.userEmail === "string" && req.query.userEmail.trim()) {
      const emailSearch = escapeRegex(req.query.userEmail.trim());
      const matchingUsers = await User.find({
        $or: [{ name: { $regex: emailSearch, $options: "i" } }, { email: { $regex: emailSearch, $options: "i" } }],
      }).select("_id");
      // No match still needs to produce an empty result set, not "no filter" —
      // an id no real ActivityLog row will ever have.
      query.userId = { $in: matchingUsers.length > 0 ? matchingUsers.map((u) => u._id) : [null] };
    }

    // CSV export ignores the cursor entirely — it's a filtered dump, not a
    // paged read — but keeps every other filter (date range, action, ip,
    // userEmail) already built into `query` above.
    if (req.query.format === "csv") {
      const entries = await ActivityLog.find(query).sort({ createdAt: -1 }).limit(10000).populate("userId", "name email");
      const csv = toCsv(
        entries.map((e) => ({
          id: e._id.toString(),
          action: e.action,
          user_name: e.userId ? e.userId.name : "",
          user_email: e.userId ? e.userId.email : "",
          ip: e.ip,
          userAgent: e.userAgent,
          metadata: e.metadata ? JSON.stringify(e.metadata) : "",
          createdAt: e.createdAt.toISOString(),
        })),
        ["id", "action", "user_name", "user_email", "ip", "userAgent", "metadata", "createdAt"]
      );
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="security-log-export.csv"');
      return res.send(csv);
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

const VIDEO_QUEUE_STATUSES = ["pending", "processing", "failed"];

adminRouter.get(
  "/video-queue",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.system");
    if (!admin) return;

    await connectDB();
    const status =
      typeof req.query.status === "string" && VIDEO_QUEUE_STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const query = { type: "video", processingStatus: status || { $in: VIDEO_QUEUE_STATUSES } };

    // Mirrors scripts/worker.js's claimNextVideo() so what's shown here
    // lines up with what the worker will actually pick up next: failed
    // items surface newest-first (the ones most likely to need attention),
    // pending/processing stay in the worker's own FIFO claim order. With no
    // status filter there's no single meaningful queue order, so it just
    // falls back to newest-first overall.
    const sort = status === "failed" ? { lastAttemptAt: -1 } : status ? { createdAt: 1 } : { createdAt: -1 };

    const [counts, items, total] = await Promise.all([
      Promise.all(VIDEO_QUEUE_STATUSES.map((s) => Media.countDocuments({ type: "video", processingStatus: s }))),
      Media.find(query)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("timelineId", "title slug"),
      Media.countDocuments(query),
    ]);

    res.json({
      counts: { pending: counts[0], processing: counts[1], failed: counts[2] },
      items: items.map((m) => ({
        id: m._id.toString(),
        timelineId: m.timelineId ? m.timelineId._id.toString() : null,
        timelineTitle: m.timelineId ? m.timelineId.title : null,
        filename: m.originalFilename,
        processingStatus: m.processingStatus,
        processingAttempts: m.processingAttempts,
        processingError: m.processingError,
        lastAttemptAt: m.lastAttemptAt,
        createdAt: m.createdAt,
      })),
      total,
      page,
      limit,
    });
  })
);

adminRouter.post(
  "/video-queue/:mediaId/retry",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const admin = await requirePermission(req, res, "platform.system");
    if (!admin) return;

    const { mediaId } = req.params;
    await connectDB();

    const media = await Media.findById(mediaId);
    if (!media) return notFound(res, "Media not found");

    if (media.type !== "video" || media.processingStatus !== "failed") {
      return badRequest(res, "Only a failed video can be retried");
    }

    // These four fields are all claimNextVideo() looks at to pick work back
    // up — no separate "requeue" entry point in the worker to call into.
    media.processingStatus = "pending";
    media.processingAttempts = 0;
    media.processingError = null;
    media.lastAttemptAt = null;
    await media.save();

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_retried_video_processing",
      ip: clientIp(req),
      metadata: { mediaId },
    });

    res.json({ ok: true });
  })
);
