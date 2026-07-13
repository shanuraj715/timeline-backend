import { Router } from "express";
import { customAlphabet } from "nanoid";
import { connectDB } from "../lib/db/connect.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
import Media from "../models/Media.js";
import DaySummary from "../models/DaySummary.js";
import Invitation from "../models/Invitation.js";
import User from "../models/User.js";
import ActivityLog from "../models/ActivityLog.js";
import { createTimelineSchema, updateTimelineSchema, inviteMemberSchema, updateMemberRoleSchema } from "../lib/validation/timeline.js";
import { parseJson, serverError, badRequest } from "../lib/apiError.js";
import {
  getCurrentUser,
  unauthorized,
  notFound,
  forbidden,
  getTimelineAndMembership,
  checkPermission,
  clientIp,
} from "../lib/auth/guards.js";
import { generateUniqueSlug } from "../lib/slug.js";
import { logActivity } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { signMediaToken } from "../lib/auth/mediaToken.js";
import { serializeMedia } from "../lib/media/serialize.js";
import { canAssignRole } from "../lib/rbac/permissions.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const timelinesRouter = Router();

const tokenId = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 32);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

timelinesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();

    const memberships = await Membership.find({ userId: user._id, status: "active" }).lean();
    const timelineIds = memberships.map((m) => m.timelineId);
    const roleByTimeline = new Map(memberships.map((m) => [m.timelineId.toString(), m.role]));

    const timelines = await Timeline.find({ _id: { $in: timelineIds }, deletedAt: null })
      .populate("coverMediaId")
      .sort({ updatedAt: -1 })
      .lean();

    const counts = await Media.aggregate([
      { $match: { timelineId: { $in: timelineIds }, deletedAt: null } },
      { $group: { _id: "$timelineId", count: { $sum: 1 } } },
    ]);
    const countByTimeline = new Map(counts.map((c) => [c._id.toString(), c.count]));

    const needsFallback = timelines.filter((t) => !t.coverMediaId).map((t) => t._id);
    const fallbackCovers = needsFallback.length
      ? await DaySummary.find({ timelineId: { $in: needsFallback } })
          .sort({ dayKey: -1 })
          .populate("coverMediaId")
      : [];
    const fallbackByTimeline = new Map();
    for (const summary of fallbackCovers) {
      const key = summary.timelineId.toString();
      if (!fallbackByTimeline.has(key) && summary.coverMediaId) {
        fallbackByTimeline.set(key, summary.coverMediaId);
      }
    }

    res.json({
      timelines: timelines.map((t) => {
        const cover = t.coverMediaId || fallbackByTimeline.get(t._id.toString());
        return {
          id: t._id.toString(),
          title: t.title,
          description: t.description,
          slug: t.slug,
          coverMedia: cover
            ? {
                id: cover._id.toString(),
                thumbnailUrl: `/api/media/${cover._id}/thumbnail?token=${signMediaToken({
                  mediaId: cover._id,
                  timelineId: t._id,
                  userId: user._id,
                })}`,
              }
            : null,
          role: roleByTimeline.get(t._id.toString()),
          mediaCount: countByTimeline.get(t._id.toString()) || 0,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        };
      }),
    });
  })
);

timelinesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const data = parseJson(req, res, createTimelineSchema);
    if (!data) return;

    try {
      await connectDB();
      const slug = await generateUniqueSlug(data.title);

      const timeline = await Timeline.create({
        title: data.title,
        description: data.description,
        slug,
        ownerId: user._id,
      });

      await Membership.create({
        timelineId: timeline._id,
        userId: user._id,
        role: "owner",
        status: "active",
      });

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_created",
        targetType: "timeline",
        targetId: timeline._id,
        ip: clientIp(req),
      });

      res.status(201).json({
        timeline: {
          id: timeline._id.toString(),
          title: timeline.title,
          description: timeline.description,
          slug: timeline.slug,
          role: "owner",
          mediaCount: 0,
          createdAt: timeline.createdAt,
        },
      });
    } catch (err) {
      serverError(res, err, "Failed to create timeline");
    }
  })
);

timelinesRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    await timeline.populate("coverMediaId");

    const memberCount = await Membership.countDocuments({ timelineId: timeline._id, status: "active" });

    let cover = timeline.coverMediaId;
    if (!cover) {
      const latestDay = await DaySummary.findOne({ timelineId: timeline._id })
        .sort({ dayKey: -1 })
        .populate("coverMediaId");
      cover = latestDay?.coverMediaId || null;
    }

    res.json({
      timeline: {
        id: timeline._id.toString(),
        title: timeline.title,
        description: timeline.description,
        slug: timeline.slug,
        coverMedia: cover
          ? {
              id: cover._id.toString(),
              thumbnailUrl: `/api/media/${cover._id}/thumbnail?token=${signMediaToken({
                mediaId: cover._id,
                timelineId: timeline._id,
                userId: user._id,
              })}`,
            }
          : null,
        settings: timeline.settings,
        role: membership.role,
        memberCount,
        createdAt: timeline.createdAt,
        updatedAt: timeline.updatedAt,
      },
    });
  })
);

timelinesRouter.patch(
  "/:slug",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("editTimelineDetails", membership, res)) return;

    const data = parseJson(req, res, updateTimelineSchema);
    if (!data) return;

    try {
      if (data.title !== undefined) timeline.title = data.title;
      if (data.description !== undefined) timeline.description = data.description;
      if (data.coverMediaId !== undefined) timeline.coverMediaId = data.coverMediaId || null;
      if (data.settings) Object.assign(timeline.settings, data.settings);
      await timeline.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_updated",
        targetType: "timeline",
        targetId: timeline._id,
        ip: clientIp(req),
      });

      res.json({
        timeline: {
          id: timeline._id.toString(),
          title: timeline.title,
          description: timeline.description,
          slug: timeline.slug,
          settings: timeline.settings,
        },
      });
    } catch (err) {
      serverError(res, err, "Failed to update timeline");
    }
  })
);

timelinesRouter.delete(
  "/:slug",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("deleteTimeline", membership, res)) return;

    try {
      timeline.deletedAt = new Date();
      await timeline.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_deleted",
        targetType: "timeline",
        targetId: timeline._id,
        ip: clientIp(req),
      });

      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to delete timeline");
    }
  })
);

timelinesRouter.get(
  "/:slug/activity",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("viewActivityLog", membership, res)) return;

    const cursor = req.query.cursor;
    const limit = Math.min(Number(req.query.limit) || 40, 100);

    const query = { timelineId: timeline._id, kind: "activity" };
    if (cursor) query.createdAt = { $lt: new Date(cursor) };

    const entries = await ActivityLog.find(query).sort({ createdAt: -1 }).limit(limit + 1).populate("userId", "name avatarUrl");
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;

    res.json({
      activity: page.map((e) => ({
        id: e._id.toString(),
        action: e.action,
        targetType: e.targetType,
        metadata: e.metadata,
        user: e.userId ? { name: e.userId.name, avatarUrl: e.userId.avatarUrl } : null,
        createdAt: e.createdAt,
      })),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    });
  })
);

const DEFAULT_DAYS_LIMIT = 30;

timelinesRouter.get(
  "/:slug/days",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("viewTimeline", membership, res)) return;

    const direction = req.query.direction;
    const cursor = req.query.cursor;
    const limit = Math.min(Number(req.query.limit) || DEFAULT_DAYS_LIMIT, 100);

    const baseQuery = { timelineId: timeline._id };
    let query = { ...baseQuery };
    let sort = { dayKey: -1 };

    if (direction === "older" && cursor) {
      query.dayKey = { $lt: cursor };
      sort = { dayKey: -1 };
    } else if (direction === "newer" && cursor) {
      query.dayKey = { $gt: cursor };
      sort = { dayKey: 1 };
    }

    let rows = await DaySummary.find(query).sort(sort).limit(limit).populate("coverMediaId").lean();

    if (sort.dayKey === -1) rows = rows.reverse();

    const days = rows.map((row) => {
      const cover = row.coverMediaId;
      return {
        dayKey: row.dayKey,
        date: row.date,
        mediaCount: row.mediaCount,
        favoriteCount: row.favoriteCount,
        cover: cover
          ? {
              id: cover._id.toString(),
              type: cover.type,
              width: cover.width,
              height: cover.height,
              thumbnailUrl: `/api/media/${cover._id}/thumbnail?token=${signMediaToken({
                mediaId: cover._id,
                timelineId: timeline._id,
                userId: user._id,
              })}`,
            }
          : null,
      };
    });

    const oldestReturned = days[0]?.dayKey;
    const newestReturned = days[days.length - 1]?.dayKey;

    const [hasOlder, hasNewer] = await Promise.all([
      oldestReturned
        ? DaySummary.exists({ ...baseQuery, dayKey: { $lt: oldestReturned } })
        : DaySummary.exists(baseQuery),
      newestReturned ? DaySummary.exists({ ...baseQuery, dayKey: { $gt: newestReturned } }) : false,
    ]);

    res.json({
      days,
      hasMore: { older: Boolean(hasOlder), newer: Boolean(hasNewer) },
    });
  })
);

timelinesRouter.get(
  "/:slug/days/:dayKey",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug, dayKey } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("viewTimeline", membership, res)) return;

    const items = await Media.find({
      timelineId: timeline._id,
      dayKey,
      deletedAt: null,
      processingStatus: { $in: ["ready", "pending", "processing", "failed"] },
    }).sort({ captureDate: 1 });

    res.json({
      media: items.map((item) =>
        serializeMedia(item, signMediaToken({ mediaId: item._id, timelineId: timeline._id, userId: user._id }))
      ),
    });
  })
);

timelinesRouter.get(
  "/:slug/facets",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("search", membership, res)) return;

    const baseQuery = { timelineId: timeline._id, deletedAt: null, processingStatus: "ready" };

    const [tags, people, years] = await Promise.all([
      Media.distinct("tags", baseQuery),
      Media.distinct("people", baseQuery),
      Media.aggregate([
        { $match: baseQuery },
        { $group: { _id: { $year: "$captureDate" } } },
        { $sort: { _id: -1 } },
      ]),
    ]);

    res.json({
      tags: tags.sort((a, b) => a.localeCompare(b)),
      people: people.sort((a, b) => a.localeCompare(b)),
      years: years.map((y) => y._id),
    });
  })
);

timelinesRouter.get(
  "/:slug/members",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("viewTimeline", membership, res)) return;

    const memberships = await Membership.find({ timelineId: timeline._id, status: "active" })
      .populate("userId", "name email avatarUrl")
      .sort({ role: 1, joinedAt: 1 })
      .lean();

    res.json({
      members: memberships
        .filter((m) => m.userId)
        .map((m) => ({
          userId: m.userId._id.toString(),
          name: m.userId.name,
          email: m.userId.email,
          avatarUrl: m.userId.avatarUrl,
          role: m.role,
          joinedAt: m.joinedAt,
        })),
    });
  })
);

timelinesRouter.patch(
  "/:slug/members/:userId",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug, userId } = req.params;
    await connectDB();
    const { timeline, membership: actorMembership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !actorMembership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("changeMemberRole", actorMembership, res)) return;

    const data = parseJson(req, res, updateMemberRoleSchema);
    if (!data) return;

    const target = await Membership.findOne({ timelineId: timeline._id, userId });
    if (!target) return notFound(res, "Member not found");
    if (target.role === "owner") return forbidden(res, "The timeline owner's role can't be changed here");
    if (!canAssignRole(actorMembership.role, data.role)) {
      return forbidden(res, "You can't grant that role");
    }

    try {
      target.role = data.role;
      await target.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "member_role_changed",
        targetType: "user",
        targetId: target.userId,
        metadata: { role: data.role },
        ip: clientIp(req),
      });

      res.json({ ok: true, role: target.role });
    } catch (err) {
      serverError(res, err, "Failed to update member role");
    }
  })
);

timelinesRouter.delete(
  "/:slug/members/:userId",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug, userId } = req.params;
    await connectDB();
    const { timeline, membership: actorMembership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !actorMembership) return unauthorized(res, "You don't have access to this timeline");

    const isSelfRemoval = userId === user._id.toString();
    if (!isSelfRemoval) {
      if (!checkPermission("removeMembers", actorMembership, res)) return;
    }

    const target = await Membership.findOne({ timelineId: timeline._id, userId });
    if (!target) return notFound(res, "Member not found");
    if (target.role === "owner") {
      return forbidden(res, "The timeline owner can't be removed. Transfer ownership first.");
    }

    try {
      await target.deleteOne();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: isSelfRemoval ? "member_left" : "member_removed",
        targetType: "user",
        targetId: target.userId,
        ip: clientIp(req),
      });

      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to remove member");
    }
  })
);

timelinesRouter.get(
  "/:slug/invitations",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("inviteMembers", membership, res)) return;

    const invitations = await Invitation.find({ timelineId: timeline._id, status: "pending" }).sort({
      createdAt: -1,
    });

    res.json({
      invitations: invitations.map((i) => ({
        id: i._id.toString(),
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    });
  })
);

timelinesRouter.post(
  "/:slug/invitations",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("inviteMembers", membership, res)) return;

    const data = parseJson(req, res, inviteMemberSchema);
    if (!data) return;

    try {
      const existingUser = await User.findOne({ email: data.email });
      if (existingUser) {
        const existingMembership = await Membership.findOne({
          timelineId: timeline._id,
          userId: existingUser._id,
          status: "active",
        });
        if (existingMembership) return badRequest(res, "This person is already a member");
      }

      await Invitation.updateMany(
        { timelineId: timeline._id, email: data.email, status: "pending" },
        { $set: { status: "revoked" } }
      );

      const invitation = await Invitation.create({
        timelineId: timeline._id,
        email: data.email,
        role: data.role,
        token: tokenId(),
        invitedBy: user._id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "member_invited",
        targetType: "invitation",
        targetId: invitation._id,
        metadata: { email: data.email, role: data.role },
        ip: clientIp(req),
      });

      res.status(201).json({
        invitation: {
          id: invitation._id.toString(),
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          inviteUrl: `${process.env.APP_URL || ""}/invite/${invitation.token}`,
        },
      });
    } catch (err) {
      serverError(res, err, "Failed to create invitation");
    }
  })
);

timelinesRouter.delete(
  "/:slug/invitations/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug, id } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("inviteMembers", membership, res)) return;

    const invitation = await Invitation.findOne({ _id: id, timelineId: timeline._id });
    if (!invitation) return notFound(res, "Invitation not found");

    try {
      invitation.status = "revoked";
      await invitation.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "invitation_revoked",
        targetType: "invitation",
        targetId: invitation._id,
        ip: clientIp(req),
      });

      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to revoke invitation");
    }
  })
);
