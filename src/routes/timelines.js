import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { customAlphabet } from "nanoid";
import { connectDB } from "../lib/db/connect.js";
import { escapeRegex } from "../lib/escapeRegex.js";
import { rateLimit } from "../lib/auth/rateLimit.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
import Media from "../models/Media.js";
import DaySummary from "../models/DaySummary.js";
import Invitation from "../models/Invitation.js";
import User from "../models/User.js";
import ActivityLog from "../models/ActivityLog.js";
import Theme from "../models/Theme.js";
import ThemeUnlock from "../models/ThemeUnlock.js";
import TimelineThemeOverride from "../models/TimelineThemeOverride.js";
import { ensureThemeUnlocked } from "../lib/themeUnlock.js";
import { serializeTheme } from "./themes.js";
import StoragePurchase from "../models/StoragePurchase.js";
import { getPlatformSettings } from "../lib/platformSettings.js";
import { getTimelineStorageQuota, getTimelineUsedBytes, formatBytes } from "../lib/storageQuota.js";
import { purchaseStorageSchema } from "../lib/validation/storage.js";
import { createTimelineSchema, updateTimelineSchema, inviteMemberSchema, updateMemberRoleSchema } from "../lib/validation/timeline.js";
import { setBaseThemeSchema, createOverrideSchema } from "../lib/validation/themes.js";
import { searchMediaSchema } from "../lib/validation/media.js";
import { parseJson, serverError, badRequest, fromZodError } from "../lib/apiError.js";
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
import { purgeTimeline } from "../lib/timelinePurge.js";
import { TRASH_RETENTION_MS } from "../lib/trashRetention.js";
import { logActivity } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { signMediaToken } from "../lib/auth/mediaToken.js";
import { serializeMedia } from "../lib/media/serialize.js";
import { sendTemplatedEmail } from "../lib/email/send.js";
import { canAssignRole, permissions } from "../lib/rbac/permissions.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFeatureEnabled } from "../lib/featureFlags.js";
import { validateMediaFile } from "../lib/media/fileValidation.js";
import { computeChecksum } from "../lib/media/checksum.js";
import { extractImageExif } from "../lib/media/exif.js";
import { generateImageDerivatives } from "../lib/media/thumbnail.js";
import { dayKeyFor } from "../lib/media/dayKey.js";
import { syncDaySummary } from "../lib/media/daySummary.js";
import { getStorage, buildStorageKey } from "../lib/storage/index.js";

export const timelinesRouter = Router();

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_SIZE_MB || 500) * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage() });

const tokenId = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 32);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

timelinesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();

    // Every membership row is needed just to know which timelines are this
    // account's at all — cheap even at a few thousand rows (indexed, tiny
    // documents, no populate). What must NOT scale with that count is
    // everything below: search/sort/pagination happens in the Timeline
    // query itself, and the per-timeline aggregates (media count, cover
    // fallback) only ever run over the current page's ids, not the whole
    // set — a dashboard with 500+ timelines (owned, or shared to one
    // person by many different owners) still does the same fixed amount of
    // work per request as one with 5.
    const memberships = await Membership.find({ userId: user._id, status: "active" }).lean();
    const timelineIds = memberships.map((m) => m.timelineId);
    const roleByTimeline = new Map(memberships.map((m) => [m.timelineId.toString(), m.role]));

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);

    const query = {
      _id: { $in: timelineIds },
      deletedAt: null,
      ...(q ? { title: { $regex: escapeRegex(q), $options: "i" } } : {}),
    };

    const [timelines, total] = await Promise.all([
      Timeline.find(query)
        .populate("coverMediaId")
        .populate("ownerId", "name email")
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Timeline.countDocuments(query),
    ]);

    const pageIds = timelines.map((t) => t._id);
    const counts = await Media.aggregate([
      { $match: { timelineId: { $in: pageIds }, deletedAt: null } },
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
          // Only meaningful for a shared (non-owner) card, but cheap enough
          // to always include rather than conditioning the populate/shape
          // on role — the frontend decides whether to render it.
          owner: t.ownerId ? { name: t.ownerId.name, email: t.ownerId.email } : null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        };
      }),
      page,
      pageCount: Math.max(Math.ceil(total / limit), 1),
      total,
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

      const settings = await getPlatformSettings();
      const ownedCount = await Timeline.countDocuments({ ownerId: user._id, deletedAt: null });
      let creditsSpent = 0;

      if (ownedCount >= settings.freeTimelinesPerAccount) {
        const freshUser = await User.findById(user._id);
        if (freshUser.credits < settings.creditsPerExtraTimeline) {
          return badRequest(
            res,
            `You've used your ${settings.freeTimelinesPerAccount} free timeline${
              settings.freeTimelinesPerAccount === 1 ? "" : "s"
            }. Creating another one costs ${settings.creditsPerExtraTimeline} credits — you have ${freshUser.credits}.`
          );
        }
        freshUser.credits -= settings.creditsPerExtraTimeline;
        await freshUser.save();
        creditsSpent = settings.creditsPerExtraTimeline;
      }

      const slug = await generateUniqueSlug(data.title);
      const defaultTheme = await Theme.findOne({ isDefault: true, status: "published" });

      const timeline = await Timeline.create({
        title: data.title,
        description: data.description,
        slug,
        ownerId: user._id,
        themeId: defaultTheme?._id || null,
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
        metadata: creditsSpent > 0 ? { creditsSpent } : undefined,
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

// A dedicated, cheap count — CreateTimelineDialog needs "how many timelines
// do I own" to show an accurate "this will cost N credits" hint before
// submit, and fetching the (paginated) full list just for a count would
// either be wrong past the first page or defeat the point of paginating.
// The real enforcement is still POST /'s own fresh count server-side; this
// is only ever a pre-submit UI hint.
timelinesRouter.get(
  "/owned-count",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    const count = await Timeline.countDocuments({ ownerId: user._id, deletedAt: null });
    res.json({ count });
  })
);

// ---- Timeline trash (registered before GET /:slug so the literal path
// "/trash" isn't swallowed by that single-segment wildcard route) ----

timelinesRouter.get(
  "/trash",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    await connectDB();
    // Only the owner can delete/restore a timeline (rbac's deleteTimeline
    // permission is owner-only), so trash is scoped to what this account
    // owns — a non-owner member never sees a deleted timeline here even if
    // they used to be a member of it.
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);
    const query = { ownerId: user._id, deletedAt: { $ne: null } };

    const [timelines, total] = await Promise.all([
      Timeline.find(query)
        .sort({ deletedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Timeline.countDocuments(query),
    ]);

    const pageIds = timelines.map((t) => t._id);
    const counts = await Media.aggregate([
      { $match: { timelineId: { $in: pageIds } } },
      { $group: { _id: "$timelineId", count: { $sum: 1 } } },
    ]);
    const countByTimeline = new Map(counts.map((c) => [c._id.toString(), c.count]));

    res.json({
      timelines: timelines.map((t) => ({
        id: t._id.toString(),
        title: t.title,
        slug: t.slug,
        mediaCount: countByTimeline.get(t._id.toString()) || 0,
        deletedAt: t.deletedAt,
        purgeAt: new Date(t.deletedAt.getTime() + TRASH_RETENTION_MS),
      })),
      page,
      pageCount: Math.max(Math.ceil(total / limit), 1),
      total,
    });
  })
);

timelinesRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { id } = req.params;
    await connectDB();
    const timeline = await Timeline.findOne({ _id: id, deletedAt: { $ne: null } });
    if (!timeline) return notFound(res, "Timeline not found in trash");
    if (!timeline.ownerId.equals(user._id)) {
      return forbidden(res, "Only the owner can restore this timeline");
    }

    try {
      timeline.deletedAt = null;
      await timeline.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_restored",
        targetType: "timeline",
        targetId: timeline._id,
        ip: clientIp(req),
      });

      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to restore timeline");
    }
  })
);

timelinesRouter.delete(
  "/:id/permanent",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { id } = req.params;
    await connectDB();
    const timeline = await Timeline.findOne({ _id: id, deletedAt: { $ne: null } });
    if (!timeline) return notFound(res, "Timeline not found in trash");
    if (!timeline.ownerId.equals(user._id)) {
      return forbidden(res, "Only the owner can permanently delete this timeline");
    }

    try {
      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_purged",
        targetType: "timeline",
        targetId: timeline._id,
        ip: clientIp(req),
      });

      await purgeTimeline(timeline);

      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to permanently delete timeline");
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
      // Soft-delete only — the owner can restore this from the dashboard's
      // Trash view (GET /trash, POST /:id/restore below) any time in the
      // next 30 days. scripts/worker.js's nightly sweep is what actually
      // erases the files and every timelineId-scoped record if nobody does.
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

// The permission (permissions.transferOwnership, owner-only) already
// existed, but nothing ever called it — an owner who wanted to hand off a
// timeline (or needed to, to satisfy /api/auth/delete-account's "transfer
// ownership first" requirement) had no route to do it through.
timelinesRouter.post(
  "/:slug/transfer-ownership",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    const newOwnerUserId = req.body?.newOwnerUserId;
    if (!newOwnerUserId || typeof newOwnerUserId !== "string") {
      return badRequest(res, "newOwnerUserId is required");
    }

    await connectDB();
    const { timeline, membership: actorMembership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !actorMembership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("transferOwnership", actorMembership, res)) return;

    if (newOwnerUserId === user._id.toString()) {
      return badRequest(res, "You already own this timeline");
    }

    const target = await Membership.findOne({ timelineId: timeline._id, userId: newOwnerUserId, status: "active" });
    if (!target) return badRequest(res, "That person must already be an active member of this timeline");

    try {
      // Not wrapped in a Mongo transaction (no replica-set requirement
      // elsewhere in this app) — sequential saves in the order that leaves
      // the timeline in the most recoverable state if one fails midway: the
      // new owner is promoted first, so a failure after that still leaves
      // two owners (recoverable/idempotent-retryable) rather than zero.
      target.role = "owner";
      await target.save();

      actorMembership.role = "admin";
      await actorMembership.save();

      timeline.ownerId = target.userId;
      await timeline.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_ownership_transferred",
        targetType: "user",
        targetId: target.userId,
        ip: clientIp(req),
      });

      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to transfer ownership");
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
    if (!(await isFeatureEnabled("invitations_enabled"))) {
      return res.status(403).json({ error: "Invitations are temporarily disabled", code: "FEATURE_DISABLED" });
    }

    // Nothing previously stopped an editor/admin member from scripting an
    // invite-spam flood against arbitrary email addresses — this is the one
    // mutating, externally-visible-effect (an email lands in someone's
    // inbox) endpoint any member with inviteMembers can hit, so it's keyed
    // per-account rather than per-IP.
    const { allowed } = rateLimit(`invite-send:${user._id}`, { limit: 20, windowMs: 10 * 60 * 1000 });
    if (!allowed) return badRequest(res, "Too many invitations sent recently. Please try again later.");

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

      const inviteUrl = `${process.env.APP_URL || ""}/invite/${invitation.token}`;
      sendTemplatedEmail("invitation", {
        to: invitation.email,
        vars: {
          inviter_name: user.name,
          timeline_title: timeline.title,
          invite_role: invitation.role,
          invite_url: inviteUrl,
          invite_expiry_days: String(Math.round(INVITE_TTL_MS / (24 * 60 * 60 * 1000))),
        },
      });

      res.status(201).json({
        invitation: {
          id: invitation._id.toString(),
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          inviteUrl,
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

/** Flat, paginated media listing (newest first) for the dashboard's Media Library / Upload Manager view. */
timelinesRouter.get(
  "/:slug/media",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("viewTimeline", membership, res)) return;

    const status = req.query.status; // pending | processing | ready | failed | undefined (all)

    const query = { timelineId: timeline._id, deletedAt: null };
    if (status) query.processingStatus = status;

    // Page-number pagination (not the cursor style the rest of this route
    // used to use) — the Media Library tab needs to jump directly to an
    // arbitrary page, which a cursor can't do.
    const pageParam = req.query.page;
    if (pageParam !== undefined) {
      const limit = Math.min(Number(req.query.limit) || 60, 100);
      const page = Math.max(Number(pageParam) || 1, 1);

      try {
        const [items, total] = await Promise.all([
          Media.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
          Media.countDocuments(query),
        ]);

        return res.json({
          media: items.map((item) =>
            serializeMedia(item, signMediaToken({ mediaId: item._id, timelineId: timeline._id, userId: user._id }))
          ),
          page,
          pageCount: Math.max(Math.ceil(total / limit), 1),
          total,
        });
      } catch (err) {
        return serverError(res, err, "Failed to load media library");
      }
    }

    // Legacy cursor mode, kept for any other caller of this route.
    const cursor = req.query.cursor;
    const limit = Math.min(Number(req.query.limit) || 60, 100);
    if (cursor) query.createdAt = { $lt: new Date(cursor) };

    try {
      const items = await Media.find(query).sort({ createdAt: -1 }).limit(limit + 1);
      const hasMore = items.length > limit;
      const cursorPage = hasMore ? items.slice(0, limit) : items;

      res.json({
        media: cursorPage.map((item) =>
          serializeMedia(item, signMediaToken({ mediaId: item._id, timelineId: timeline._id, userId: user._id }))
        ),
        hasMore,
        nextCursor: hasMore ? cursorPage[cursorPage.length - 1].createdAt.toISOString() : null,
      });
    } catch (err) {
      serverError(res, err, "Failed to load media library");
    }
  })
);

function checkUploadContentLength(req, res, next) {
  // Reject an oversized request by its declared Content-Length before
  // multer buffers the whole multipart body into memory — the size check
  // inside processOneUpload runs too late to prevent that. (A reverse
  // proxy in front of this app should enforce its own body-size cap too —
  // see README — since Content-Length can be omitted or spoofed.)
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: "File is too large", code: "PAYLOAD_TOO_LARGE" });
  }
  next();
}

// Declaring `upload.single("file")` directly as route middleware means a
// malformed multipart body (wrong field name, truncated boundary — a flaky
// mobile network mangling the request, or a stale cached frontend bundle
// still sending the old "files" field name from before this endpoint
// became single-file) throws a MulterError that skips straight past this
// route's own try/catch to server.js's generic fallback handler as a bare,
// unhelpful 500. Invoking it manually with its own callback catches that
// error right here instead, as a clean 400.
function handleSingleFileUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: "Invalid upload request", code: "BAD_REQUEST" });
    }
    next(err);
  });
}

// One file per request, sent one at a time — not a multi-file batch. This
// used to accept an array and process it with bounded concurrency, but a
// single file's own failure (a corrupt upload, a storage write error, an
// EXIF/thumbnail crash — none of processOneUpload's steps besides image
// thumbnailing were wrapped in their own try/catch) threw past the
// concurrency pool uncaught, past this handler, and into Express's generic
// error middleware as a bare 500 — for the *entire* batch, silently losing
// the results of every other file in it that had already succeeded. One
// file per request means one failure only ever affects that one file, and
// the try/catch below turns it into a clean, specific error response
// instead of an opaque 500.
timelinesRouter.post(
  "/:slug/media",
  checkUploadContentLength,
  handleSingleFileUpload,
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("uploadMedia", membership, res)) return;
    if (membership.role === "editor" && !timeline.settings.allowMemberUploads) {
      return forbidden(res, "The timeline owner has disabled uploads from editors");
    }
    if (!(await isFeatureEnabled("uploads_enabled"))) {
      return res.status(403).json({ error: "Uploads are temporarily disabled", code: "FEATURE_DISABLED" });
    }

    const { allowed } = rateLimit(`media-upload:${user._id}`, { limit: 60, windowMs: 10 * 60 * 1000 });
    if (!allowed) return badRequest(res, "Too many upload requests recently. Please try again in a few minutes.");

    const file = req.file;
    if (!file) return badRequest(res, "No file was provided");

    const [usedBytes, quotaBytes] = await Promise.all([
      getTimelineUsedBytes(timeline._id),
      getTimelineStorageQuota(timeline),
    ]);
    if (usedBytes + file.size > quotaBytes) {
      const remaining = Math.max(quotaBytes - usedBytes, 0);
      return res.status(413).json({
        error: `This timeline has ${formatBytes(remaining)} of storage left, but this file needs ${formatBytes(
          file.size
        )}. Buy more storage to continue.`,
        code: "STORAGE_QUOTA_EXCEEDED",
      });
    }

    try {
      const result = await processOneUpload({
        file,
        clientDate: req.body.clientDate,
        timeline,
        userId: user._id,
        ip: clientIp(req),
      });
      res.status(201).json({ result });
    } catch (err) {
      serverError(res, err, "Failed to upload file");
    }
  })
);

async function processOneUpload({ file, clientDate, timeline, userId, ip }) {
  const filename = file.originalname || "upload";

  if (file.size > MAX_UPLOAD_BYTES) {
    return { filename, status: "failed", error: `File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit` };
  }

  const buffer = file.buffer;

  const validation = await validateMediaFile(buffer);
  if (!validation.valid) {
    return { filename, status: "failed", error: validation.reason };
  }

  const checksum = computeChecksum(buffer);
  const duplicate = await Media.findOne({ timelineId: timeline._id, checksum, deletedAt: null });
  if (duplicate) {
    return { filename, status: "duplicate", mediaId: duplicate._id.toString() };
  }

  let captureDate = null;
  let captureDateSource = "upload";
  let exifLocation = null;
  let exifCamera = null;

  if (validation.type === "image") {
    const exif = await extractImageExif(buffer);
    if (exif.captureDate) {
      captureDate = exif.captureDate;
      captureDateSource = "exif";
    }
    // Previously extracted and then silently discarded — gps/camera were
    // computed here but never attached to the created Media doc, so every
    // photo with real GPS/camera EXIF data lost it on upload.
    if (exif.gps) exifLocation = { name: "", lat: exif.gps.lat, lng: exif.gps.lng };
    if (exif.camera) exifCamera = exif.camera;
  }
  if (!captureDate && clientDate) {
    const parsed = new Date(clientDate);
    if (!Number.isNaN(parsed.getTime())) {
      captureDate = parsed;
      captureDateSource = "manual";
    }
  }
  if (!captureDate) captureDate = new Date();

  const dayKey = dayKeyFor(captureDate);
  const mediaId = new mongoose.Types.ObjectId();

  const originalKey = buildStorageKey({
    timelineId: timeline._id,
    dayKey,
    mediaId,
    extension: validation.extension,
    variant: "original",
  });
  const storage = await getStorage();
  await storage.write(originalKey, buffer);

  const baseDoc = {
    _id: mediaId,
    timelineId: timeline._id,
    uploaderId: userId,
    type: validation.type,
    storageKey: originalKey,
    checksum,
    mimeType: validation.mime,
    originalFilename: filename,
    size: file.size,
    captureDate,
    captureDateSource,
    dayKey,
    ...(exifLocation ? { location: exifLocation } : {}),
    ...(exifCamera ? { camera: exifCamera } : {}),
  };

  let media;

  if (validation.type === "image") {
    try {
      const { width, height, thumbnailBuffer, previewBuffer } = await generateImageDerivatives(buffer);

      const thumbnailKey = buildStorageKey({
        timelineId: timeline._id,
        dayKey,
        mediaId,
        extension: ".webp",
        variant: "thumbnail",
      });
      const previewKey = buildStorageKey({
        timelineId: timeline._id,
        dayKey,
        mediaId,
        extension: ".webp",
        variant: "preview",
      });
      await Promise.all([
        storage.write(thumbnailKey, thumbnailBuffer),
        storage.write(previewKey, previewBuffer),
      ]);

      media = await Media.create({
        ...baseDoc,
        width,
        height,
        thumbnailKey,
        previewKey,
        processingStatus: "ready",
      });
    } catch (err) {
      media = await Media.create({
        ...baseDoc,
        processingStatus: "failed",
        processingError: "Could not generate a thumbnail for this image",
        processingAttempts: 1,
        lastAttemptAt: new Date(),
      });
      console.error("Image processing failed:", err);
    }
  } else {
    // Video thumbnailing is deferred to the background worker (scripts/worker.js).
    media = await Media.create({ ...baseDoc, processingStatus: "pending" });
  }

  if (media.processingStatus === "ready") {
    await syncDaySummary(timeline._id, dayKey);
  }

  await logActivity({
    userId,
    timelineId: timeline._id,
    action: "media_uploaded",
    targetType: "media",
    targetId: media._id,
    metadata: { type: validation.type, filename },
    ip,
  });

  const token = signMediaToken({ mediaId: media._id, timelineId: timeline._id, userId });

  return {
    filename,
    status: media.processingStatus,
    mediaId: media._id.toString(),
    dayKey,
    token,
  };
}

timelinesRouter.get(
  "/:slug/media/search",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("search", membership, res)) return;

    const raw = {
      q: req.query.q || undefined,
      year: req.query.year || undefined,
      month: req.query.month || undefined,
      tags: req.query.tags ? req.query.tags.split(",").filter(Boolean) : undefined,
      people: req.query.people ? req.query.people.split(",").filter(Boolean) : undefined,
      location: req.query.location || undefined,
      favorite: req.query.favorite !== undefined ? req.query.favorite === "true" : undefined,
      type: req.query.type || undefined,
      dateFrom: req.query.dateFrom || undefined,
      dateTo: req.query.dateTo || undefined,
      cursor: req.query.cursor || undefined,
      limit: req.query.limit || undefined,
    };

    let data;
    try {
      data = searchMediaSchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) return fromZodError(res, err);
      throw err;
    }

    const query = {
      timelineId: timeline._id,
      deletedAt: null,
      processingStatus: "ready",
    };

    if (data.q) query.$text = { $search: data.q };
    if (data.type) query.type = data.type;
    if (data.favorite !== undefined) query.favorite = data.favorite;
    if (data.tags?.length) query.tags = { $in: data.tags };
    if (data.people?.length) query.people = { $in: data.people };
    if (data.location) query["location.name"] = { $regex: escapeRegex(data.location), $options: "i" };

    const dateConditions = {};
    if (data.year) {
      const start = new Date(Date.UTC(data.year, 0, 1));
      const end = new Date(Date.UTC(data.year + 1, 0, 1));
      dateConditions.$gte = start;
      dateConditions.$lt = end;
    }
    if (data.dateFrom) dateConditions.$gte = data.dateFrom;
    if (data.dateTo) dateConditions.$lte = data.dateTo;
    if (Object.keys(dateConditions).length) query.captureDate = dateConditions;

    if (data.month) query.$expr = { $eq: [{ $month: "$captureDate" }, data.month] };

    if (data.cursor) {
      const cursorDate = new Date(data.cursor);
      if (Number.isNaN(cursorDate.getTime())) return badRequest(res, "Invalid cursor");
      query.captureDate = { ...(query.captureDate || {}), $lt: cursorDate };
    }

    const projection = data.q ? { score: { $meta: "textScore" } } : {};
    const sort = data.q ? { score: { $meta: "textScore" }, captureDate: -1 } : { captureDate: -1 };

    const results = await Media.find(query, projection)
      .sort(sort)
      .limit(data.limit + 1)
      .lean();

    const hasMore = results.length > data.limit;
    const page = hasMore ? results.slice(0, data.limit) : results;

    res.json({
      results: page.map((item) =>
        serializeMedia(item, signMediaToken({ mediaId: item._id, timelineId: timeline._id, userId: user._id }))
      ),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1].captureDate.toISOString() : null,
    });
  })
);

timelinesRouter.get(
  "/:slug/trash",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("uploadMedia", membership, res)) return; // editor+ manage trash

    const limit = Math.min(Number(req.query.limit) || 60, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const query = { timelineId: timeline._id, deletedAt: { $ne: null } };

    const [items, total] = await Promise.all([
      Media.find(query)
        .sort({ deletedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Media.countDocuments(query),
    ]);

    res.json({
      media: items.map((item) =>
        serializeMedia(item, signMediaToken({ mediaId: item._id, timelineId: timeline._id, userId: user._id }))
      ),
      page,
      pageCount: Math.max(Math.ceil(total / limit), 1),
      total,
    });
  })
);

// ---- Theme ----
// Resolution ("which theme is active today" vs "which theme was active on
// a specific day being viewed") is deliberately left to the frontend —
// these routes just hand over the base theme + the full override list, so
// one GET works for both the ambient page-level context (today) and the
// media viewer's per-day context (that day's own date) without needing
// two different backend endpoints.

timelinesRouter.get(
  "/:slug/theme",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("viewTimeline", membership, res)) return;

    const [baseTheme, overrides] = await Promise.all([
      timeline.themeId ? Theme.findById(timeline.themeId) : null,
      TimelineThemeOverride.find({ timelineId: timeline._id }).populate("themeId").sort({ startDate: 1 }),
    ]);

    res.json({
      baseTheme: baseTheme ? serializeTheme(baseTheme) : null,
      overrides: overrides
        .filter((o) => o.themeId) // guard against a since-deleted theme
        .map((o) => ({
          id: o._id.toString(),
          theme: serializeTheme(o.themeId),
          startDate: o.startDate,
          endDate: o.endDate,
          label: o.label,
        })),
    });
  })
);

timelinesRouter.get(
  "/:slug/theme/catalog",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("changeTimelineTheme", membership, res)) return;

    const [themes, unlocks] = await Promise.all([
      Theme.find({ status: "published" }).sort({ order: 1, createdAt: -1 }),
      ThemeUnlock.find({ timelineId: timeline._id }),
    ]);
    const unlockedThemeIds = new Set(unlocks.map((u) => u.themeId.toString()));

    res.json({
      themes: themes.map((t) => ({
        ...serializeTheme(t),
        isUnlocked: t.priceCredits === 0 || unlockedThemeIds.has(t._id.toString()),
        isCurrent: timeline.themeId?.toString() === t._id.toString(),
      })),
    });
  })
);

timelinesRouter.put(
  "/:slug/theme",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("changeTimelineTheme", membership, res)) return;

    const data = parseJson(req, res, setBaseThemeSchema);
    if (!data) return;

    try {
      const theme = await Theme.findOne({ _id: data.themeId, status: "published" });
      if (!theme) return notFound(res, "Theme not found");

      const unlock = await ensureThemeUnlocked(timeline._id, theme, user);
      if (!unlock.ok) return badRequest(res, unlock.error);

      timeline.themeId = theme._id;
      await timeline.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_theme_changed",
        targetType: "theme",
        targetId: theme._id,
        ip: clientIp(req),
      });

      res.json({ baseTheme: serializeTheme(theme) });
    } catch (err) {
      serverError(res, err, "Failed to change theme");
    }
  })
);

timelinesRouter.post(
  "/:slug/theme/overrides",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("changeTimelineTheme", membership, res)) return;

    const data = parseJson(req, res, createOverrideSchema);
    if (!data) return;

    try {
      const theme = await Theme.findOne({ _id: data.themeId, status: "published" });
      if (!theme) return notFound(res, "Theme not found");

      const overlap = await TimelineThemeOverride.findOne({
        timelineId: timeline._id,
        startDate: { $lte: data.endDate },
        endDate: { $gte: data.startDate },
      });
      if (overlap) return badRequest(res, "This date range overlaps an existing theme override");

      const unlock = await ensureThemeUnlocked(timeline._id, theme, user);
      if (!unlock.ok) return badRequest(res, unlock.error);

      const override = await TimelineThemeOverride.create({
        timelineId: timeline._id,
        themeId: theme._id,
        startDate: data.startDate,
        endDate: data.endDate,
        label: data.label || theme.name,
      });

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_theme_override_added",
        targetType: "theme",
        targetId: theme._id,
        metadata: { startDate: data.startDate, endDate: data.endDate },
        ip: clientIp(req),
      });

      res.status(201).json({
        override: {
          id: override._id.toString(),
          theme: serializeTheme(theme),
          startDate: override.startDate,
          endDate: override.endDate,
          label: override.label,
        },
      });
    } catch (err) {
      serverError(res, err, "Failed to add theme override");
    }
  })
);

timelinesRouter.delete(
  "/:slug/theme/overrides/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug, id } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("changeTimelineTheme", membership, res)) return;

    const override = await TimelineThemeOverride.findOneAndDelete({ _id: id, timelineId: timeline._id });
    if (!override) return notFound(res, "Theme override not found");

    res.json({ ok: true });
  })
);

// ---- Storage quota ----

timelinesRouter.get(
  "/:slug/storage",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("viewTimeline", membership, res)) return;

    const [usedBytes, settings] = await Promise.all([getTimelineUsedBytes(timeline._id), getPlatformSettings()]);

    res.json({
      usedBytes,
      quotaBytes: settings.freeStorageBytesPerTimeline + timeline.purchasedStorageBytes,
      purchasedBytes: timeline.purchasedStorageBytes,
      canManage: permissions.manageTimelineStorage(membership.role),
      unitBytes: settings.storageUnitBytes,
      unitPriceCredits: settings.storageUnitPriceCredits,
    });
  })
);

timelinesRouter.post(
  "/:slug/storage/purchase",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { slug } = req.params;
    await connectDB();
    const { timeline, membership } = await getTimelineAndMembership(slug, user._id);
    if (!timeline || !membership) return unauthorized(res, "You don't have access to this timeline");

    if (!checkPermission("manageTimelineStorage", membership, res)) return;

    const data = parseJson(req, res, purchaseStorageSchema);
    if (!data) return;

    try {
      const settings = await getPlatformSettings();

      // The request only ever carries how many bytes are wanted — never a
      // cost — so there's nothing for a tampered payload to lie about: the
      // price is always derived here from the *current* rate, and the
      // amount itself must be an exact whole multiple of that rate's unit
      // (no buying 101MB when the unit is 100MB).
      if (data.bytes % settings.storageUnitBytes !== 0) {
        const nearestValid = Math.max(
          Math.round(data.bytes / settings.storageUnitBytes) * settings.storageUnitBytes,
          settings.storageUnitBytes
        );
        return badRequest(
          res,
          `Storage can only be bought in multiples of ${formatBytes(settings.storageUnitBytes)} — try ${formatBytes(nearestValid)}.`
        );
      }

      const units = data.bytes / settings.storageUnitBytes;
      const creditsToSpend = units * settings.storageUnitPriceCredits;

      // Atomic debit: the $gte guard makes the balance check and the
      // deduction a single operation, closing the race where two concurrent
      // purchases (e.g. a double-click) could both read a sufficient
      // balance before either write lands and both succeed in overdrawing
      // the account.
      const updatedUser = await User.findOneAndUpdate(
        { _id: user._id, credits: { $gte: creditsToSpend } },
        { $inc: { credits: -creditsToSpend } },
        { new: true }
      );
      if (!updatedUser) {
        const freshUser = await User.findById(user._id);
        return badRequest(
          res,
          `Not enough credits — this costs ${creditsToSpend}, you have ${freshUser?.credits ?? 0}.`
        );
      }

      const updatedTimeline = await Timeline.findByIdAndUpdate(
        timeline._id,
        { $inc: { purchasedStorageBytes: data.bytes } },
        { new: true }
      );

      await StoragePurchase.create({
        timelineId: timeline._id,
        bytesGranted: data.bytes,
        creditsSpent: creditsToSpend,
        purchasedByUserId: user._id,
      });

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "timeline_storage_purchased",
        targetType: "timeline",
        targetId: timeline._id,
        metadata: { bytes: data.bytes, creditsSpent: creditsToSpend },
        ip: clientIp(req),
      });

      res.json({
        ok: true,
        quotaBytes: settings.freeStorageBytesPerTimeline + updatedTimeline.purchasedStorageBytes,
        purchasedBytes: updatedTimeline.purchasedStorageBytes,
        credits: updatedUser.credits,
      });
    } catch (err) {
      serverError(res, err, "Failed to purchase storage");
    }
  })
);
