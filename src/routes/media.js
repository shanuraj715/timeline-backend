import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import Media from "../models/Media.js";
import Membership from "../models/Membership.js";
import { updateMediaSchema } from "../lib/validation/media.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { getCurrentUser, unauthorized, notFound, checkPermission, clientIp } from "../lib/auth/guards.js";
import { authorizeMediaAccess } from "../lib/auth/mediaAccess.js";
import { dayKeyFor } from "../lib/media/dayKey.js";
import { syncDaySummary } from "../lib/media/daySummary.js";
import { signMediaToken } from "../lib/auth/mediaToken.js";
import { serializeMedia } from "../lib/media/serialize.js";
import { logActivity } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { getStorage } from "../lib/storage/index.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const mediaRouter = Router();

mediaRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    await connectDB();
    const { id } = req.params;
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const auth = await authorizeMediaAccess(id, null, req);
    if (!auth) return notFound(res, "Media not found");

    const token = signMediaToken({ mediaId: auth.media._id, timelineId: auth.media.timelineId, userId: user._id });
    res.json({ media: serializeMedia(auth.media, token) });
  })
);

mediaRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { id } = req.params;
    await connectDB();

    const media = await Media.findOne({ _id: id, deletedAt: null });
    if (!media) return notFound(res, "Media not found");

    const membership = await Membership.findOne({ timelineId: media.timelineId, userId: user._id, status: "active" });
    if (!membership) return unauthorized(res, "You don't have access to this timeline");
    if (!checkPermission("editMediaMetadata", membership, res)) return;

    const data = parseJson(req, res, updateMediaSchema);
    if (!data) return;

    try {
      const previousDayKey = media.dayKey;

      if (data.title !== undefined) media.title = data.title;
      if (data.description !== undefined) media.description = data.description;
      if (data.favorite !== undefined) media.favorite = data.favorite;
      if (data.tags !== undefined) media.tags = data.tags;
      if (data.people !== undefined) media.people = data.people;
      if (data.location !== undefined) Object.assign(media.location, data.location);
      if (data.captureDate !== undefined) {
        media.captureDate = data.captureDate;
        media.captureDateSource = "manual";
        media.dayKey = dayKeyFor(data.captureDate);
      }

      await media.save();

      if (media.processingStatus === "ready") {
        await syncDaySummary(media.timelineId, media.dayKey);
        if (previousDayKey !== media.dayKey) await syncDaySummary(media.timelineId, previousDayKey);
      }

      await logActivity({
        userId: user._id,
        timelineId: media.timelineId,
        action: "media_updated",
        targetType: "media",
        targetId: media._id,
        ip: clientIp(req),
      });

      const token = signMediaToken({ mediaId: media._id, timelineId: media.timelineId, userId: user._id });
      res.json({ media: serializeMedia(media, token) });
    } catch (err) {
      serverError(res, err, "Failed to update media");
    }
  })
);

mediaRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { id } = req.params;
    await connectDB();

    const media = await Media.findById(id);
    if (!media) return notFound(res, "Media not found");

    const membership = await Membership.findOne({ timelineId: media.timelineId, userId: user._id, status: "active" });
    if (!membership) return unauthorized(res, "You don't have access to this timeline");
    if (!checkPermission("deleteMedia", membership, res)) return;

    const alreadyTrashed = Boolean(media.deletedAt);

    try {
      if (alreadyTrashed) {
        const storage = await getStorage();
        await Promise.all(
          [media.storageKey, media.thumbnailKey, media.previewKey]
            .filter(Boolean)
            .map((key) => storage.remove(key).catch((err) => console.error("Failed to remove storage key:", key, err)))
        );
        await Media.deleteOne({ _id: media._id });

        await logActivity({
          userId: user._id,
          timelineId: media.timelineId,
          action: "media_permanently_deleted",
          targetType: "media",
          targetId: media._id,
          ip: clientIp(req),
        });

        return res.json({ ok: true, permanent: true });
      }

      media.deletedAt = new Date();
      await media.save();
      await syncDaySummary(media.timelineId, media.dayKey);

      await logActivity({
        userId: user._id,
        timelineId: media.timelineId,
        action: "media_deleted",
        targetType: "media",
        targetId: media._id,
        ip: clientIp(req),
      });

      res.json({ ok: true, permanent: false });
    } catch (err) {
      serverError(res, err, "Failed to delete media");
    }
  })
);

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;

  const [, startStr, endStr] = match;
  let start = startStr ? parseInt(startStr, 10) : size - parseInt(endStr, 10);
  let end = endStr && startStr ? parseInt(endStr, 10) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) return null;

  return { start, end: Math.min(end, size - 1) };
}

mediaRouter.get(
  "/:id/file",
  asyncHandler(async (req, res) => {
    await connectDB();
    const { id } = req.params;
    const token = req.query.token;
    const variant = req.query.variant === "preview" ? "preview" : "original";

    const auth = await authorizeMediaAccess(id, token, req);
    if (!auth) return unauthorized(res, "You don't have access to this file");

    const { media } = auth;
    const storageKey = variant === "preview" && media.previewKey ? media.previewKey : media.storageKey;
    const contentType = variant === "preview" ? "image/webp" : media.mimeType;

    const storage = await getStorage();
    if (!(await storage.exists(storageKey))) return notFound(res, "File not found in storage");

    const rangeHeader = req.headers.range;

    try {
      const { size: totalSize } = await storage.stat(storageKey);
      const range = parseRange(rangeHeader, totalSize);

      const { stream, size, start, end } = await storage.createReadStream(storageKey, range);

      const disposition = req.query.download ? "attachment" : "inline";
      const headers = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=86400, must-revalidate",
        "Content-Disposition": `${disposition}; filename="${encodeURIComponent(media.originalFilename || media._id.toString())}"`,
        "Content-Length": String(end - start + 1),
      };

      if (range) {
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        res.writeHead(206, headers);
      } else {
        res.writeHead(200, headers);
      }
      stream.pipe(res);
    } catch (err) {
      console.error("Failed to stream media file:", err);
      notFound(res, "File not found in storage");
    }
  })
);

mediaRouter.get(
  "/:id/thumbnail",
  asyncHandler(async (req, res) => {
    await connectDB();
    const { id } = req.params;
    const token = req.query.token;

    const auth = await authorizeMediaAccess(id, token, req);
    if (!auth) return unauthorized(res, "You don't have access to this file");

    const { media } = auth;
    if (!media.thumbnailKey) return notFound(res, "Thumbnail not ready yet");

    try {
      const storage = await getStorage();
      const { stream, size } = await storage.createReadStream(media.thumbnailKey, null);

      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Cache-Control": "private, max-age=604800, immutable",
        "Content-Length": String(size),
      });
      stream.pipe(res);
    } catch (err) {
      console.error("Failed to stream thumbnail:", err);
      notFound(res, "Thumbnail not found in storage");
    }
  })
);

// Mints a long-TTL variant of the same signed token every media list/detail
// response already embeds (see lib/auth/mediaToken.js) — the file route
// already accepts a token in place of a cookie session (authorizeMediaAccess's
// fast path), so a longer TTL is the entire mechanism needed to make that
// URL work for a recipient with no account at all, not a separate sharing
// subsystem. Deliberately time-limited (7 days) rather than forever, since
// there's no revocation list for a bare HMAC token — it can only ever
// expire, not be individually invalidated.
const SHARE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

mediaRouter.post(
  "/:id/share",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { id } = req.params;
    await connectDB();

    const media = await Media.findOne({ _id: id, deletedAt: null });
    if (!media) return notFound(res, "Media not found");

    const membership = await Membership.findOne({ timelineId: media.timelineId, userId: user._id, status: "active" });
    if (!membership) return unauthorized(res, "You don't have access to this timeline");
    if (!checkPermission("viewMedia", membership, res)) return;

    const token = signMediaToken(
      { mediaId: media._id, timelineId: media.timelineId, userId: user._id },
      SHARE_LINK_TTL_SECONDS
    );
    const url = `${process.env.APP_URL || ""}/api/media/${media._id}/file?token=${token}&download=1`;

    await logActivity({
      userId: user._id,
      timelineId: media.timelineId,
      action: "media_share_link_created",
      targetType: "media",
      targetId: media._id,
      ip: clientIp(req),
    });

    res.json({ url, expiresAt: new Date(Date.now() + SHARE_LINK_TTL_SECONDS * 1000) });
  })
);

mediaRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { id } = req.params;
    await connectDB();

    const media = await Media.findOne({ _id: id, deletedAt: { $ne: null } });
    if (!media) return notFound(res, "Media not found in trash");

    const membership = await Membership.findOne({ timelineId: media.timelineId, userId: user._id, status: "active" });
    if (!membership) return unauthorized(res, "You don't have access to this timeline");
    if (!checkPermission("restoreMedia", membership, res)) return;

    try {
      media.deletedAt = null;
      await media.save();
      if (media.processingStatus === "ready") await syncDaySummary(media.timelineId, media.dayKey);

      await logActivity({
        userId: user._id,
        timelineId: media.timelineId,
        action: "media_restored",
        targetType: "media",
        targetId: media._id,
        ip: clientIp(req),
      });

      res.json({ ok: true });
    } catch (err) {
      serverError(res, err, "Failed to restore media");
    }
  })
);
