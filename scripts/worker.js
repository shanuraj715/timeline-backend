// Standalone background worker — runs as its own long-lived Node process
// (see docker-compose.yml / `npm run worker`), separate from the Express
// web process. Handles the two things that must never block an HTTP
// response and must survive a process restart:
//   1. Video thumbnail generation (ffmpeg frame extraction + duration probe)
//   2. Permanently purging trash (media + timelines) older than 30 days —
//      deleting either just sets `deletedAt`; the frontend's Trash view
//      (media: trash-panel.jsx, timelines: dashboard/trash) is what lets
//      someone restore within that window, and this sweep is what actually
//      erases anything nobody restored in time.
//
// State for both lives entirely in MongoDB (processingStatus/attempts on
// Media, deletedAt timestamps), so a crash mid-job just leaves work to be
// picked up again on the next poll — nothing is lost.

import "dotenv/config";
import os from "os";
import path from "path";
import fs from "fs/promises";
import cron from "node-cron";
import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { connectDB } from "../src/lib/db/connect.js";
import Media from "../src/models/Media.js";
import Timeline from "../src/models/Timeline.js";
import DaySummary from "../src/models/DaySummary.js";
import { getStorage, buildStorageKey } from "../src/lib/storage/index.js";
import { purgeTimeline } from "../src/lib/timelinePurge.js";
import { TRASH_RETENTION_MS } from "../src/lib/trashRetention.js";
import { probeVideo, extractVideoFrame } from "../src/lib/media/video.js";
import { generateImageDerivatives } from "../src/lib/media/thumbnail.js";
import { syncDaySummary } from "../src/lib/media/daySummary.js";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 15000);
const TRASH_SWEEP_CRON = process.env.WORKER_TRASH_SWEEP_CRON || "0 3 * * *";
const DAY_SUMMARY_RECONCILE_CRON = process.env.WORKER_DAY_SUMMARY_RECONCILE_CRON || "30 3 * * *";
const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 15 * 60 * 1000; // recover jobs orphaned by a crashed worker

async function claimNextVideo() {
  const staleThreshold = new Date(Date.now() - STALE_PROCESSING_MS);
  return Media.findOneAndUpdate(
    {
      type: "video",
      deletedAt: null,
      $or: [
        { processingStatus: "pending" },
        { processingStatus: "processing", lastAttemptAt: { $lt: staleThreshold } },
      ],
    },
    { $set: { processingStatus: "processing", lastAttemptAt: new Date() }, $inc: { processingAttempts: 1 } },
    { new: true, sort: { createdAt: 1 } }
  );
}

async function processVideo(media) {
  const tempPath = path.join(os.tmpdir(), `${randomUUID()}${path.extname(media.storageKey) || ".mp4"}`);

  try {
    const storage = await getStorage();
    const original = await storage.read(media.storageKey);
    await fs.writeFile(tempPath, original);

    const { duration, width, height } = await probeVideo(tempPath);
    const frameBuffer = await extractVideoFrame(tempPath, duration);
    const { thumbnailBuffer, previewBuffer } = await generateImageDerivatives(frameBuffer);

    const thumbnailKey = buildStorageKey({
      timelineId: media.timelineId,
      dayKey: media.dayKey,
      mediaId: media._id,
      extension: ".webp",
      variant: "thumbnail",
    });
    const previewKey = buildStorageKey({
      timelineId: media.timelineId,
      dayKey: media.dayKey,
      mediaId: media._id,
      extension: ".webp",
      variant: "preview",
    });

    await Promise.all([
      storage.write(thumbnailKey, thumbnailBuffer),
      storage.write(previewKey, previewBuffer),
    ]);

    media.duration = duration;
    media.width = width;
    media.height = height;
    media.thumbnailKey = thumbnailKey;
    media.previewKey = previewKey;
    media.processingStatus = "ready";
    media.processingError = null;
    await media.save();

    await syncDaySummary(media.timelineId, media.dayKey);
    console.log(`[worker] processed video ${media._id}`);
  } catch (err) {
    console.error(`[worker] failed to process video ${media._id}:`, err.message);
    media.processingError = err.message?.slice(0, 500) || "Unknown error";
    media.processingStatus = media.processingAttempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await media.save();
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function videoProcessingTick() {
  const media = await claimNextVideo();
  if (!media) return;
  await processVideo(media);
  // Keep draining while work is available instead of waiting for the next poll.
  setImmediate(videoProcessingTick);
}

async function purgeExpiredMedia() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);
  const expired = await Media.find({ deletedAt: { $ne: null, $lt: cutoff } });
  if (expired.length === 0) return;

  const storage = await getStorage();
  for (const media of expired) {
    await Promise.allSettled(
      [media.storageKey, media.thumbnailKey, media.previewKey]
        .filter(Boolean)
        .map((key) => storage.remove(key))
    );
    await Media.deleteOne({ _id: media._id });
  }
  console.log(`[worker] purged ${expired.length} trashed media item(s)`);
}

// Mirrors purgeExpiredMedia above, one level up: deleting a timeline
// (routes/timelines.js's DELETE /:slug) only sets `deletedAt` — the owner
// can restore it from the dashboard's Trash view (GET /api/timelines/trash,
// POST /:id/restore) any time before this sweep gets to it. Every model
// with a timelineId gets cleaned up here except ActivityLog, which is left
// alone deliberately as an audit trail: it should still be possible to
// answer "who deleted timeline X and when" after the timeline itself is
// gone, the same way a security log isn't expected to erase its own
// history just because the thing it logged no longer exists.
async function purgeExpiredTimelines() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);
  const expired = await Timeline.find({ deletedAt: { $ne: null, $lt: cutoff } });
  if (expired.length === 0) return;

  for (const timeline of expired) {
    await purgeTimeline(timeline);
    console.log(`[worker] permanently purged timeline ${timeline._id}`);
  }
}

async function trashSweep() {
  console.log("[worker] running trash sweep");
  await purgeExpiredMedia();
  await purgeExpiredTimelines();
}

// DaySummary (lib/media/daySummary.js's syncDaySummary) is recomputed from
// Media on every write path that touches it, but each of those is a
// separate, non-transactional write — a crash between the two (or any
// write path that's ever missed a call) leaves a day-node's count/cover
// stale until *something else* touches that same day again. This is the
// self-healing backstop: recompute every (timeline, day) pair that appears
// in either collection, so drift can't accumulate indefinitely even if it's
// never otherwise triggered again. syncDaySummary is already idempotent
// (upsert-or-delete from a fresh aggregate), so running it on rows that
// were never actually out of sync is a correct no-op, not wasted work in
// any way that matters at this scale.
async function reconcileDaySummaries() {
  console.log("[worker] running DaySummary reconciliation");

  const [mediaDayKeys, summaryDayKeys] = await Promise.all([
    Media.aggregate([
      { $match: { deletedAt: null, processingStatus: "ready" } },
      { $group: { _id: { timelineId: "$timelineId", dayKey: "$dayKey" } } },
    ]),
    DaySummary.aggregate([{ $group: { _id: { timelineId: "$timelineId", dayKey: "$dayKey" } } }]),
  ]);

  const keys = new Map();
  for (const { _id } of [...mediaDayKeys, ...summaryDayKeys]) {
    keys.set(`${_id.timelineId}:${_id.dayKey}`, _id);
  }

  for (const { timelineId, dayKey } of keys.values()) {
    await syncDaySummary(timelineId, dayKey);
  }

  console.log(`[worker] reconciled ${keys.size} day-summary row(s)`);
}

async function main() {
  await connectDB();
  console.log("[worker] connected to MongoDB");

  await videoProcessingTick();
  setInterval(videoProcessingTick, POLL_INTERVAL_MS);

  cron.schedule(TRASH_SWEEP_CRON, () => {
    trashSweep().catch((err) => console.error("[worker] trash sweep failed:", err));
  });

  cron.schedule(DAY_SUMMARY_RECONCILE_CRON, () => {
    reconcileDaySummaries().catch((err) => console.error("[worker] DaySummary reconciliation failed:", err));
  });

  console.log(
    `[worker] polling for video jobs every ${POLL_INTERVAL_MS}ms; trash sweep "${TRASH_SWEEP_CRON}"; day-summary reconcile "${DAY_SUMMARY_RECONCILE_CRON}"`
  );
}

main().catch((err) => {
  console.error("[worker] fatal error:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await mongoose.connection.close();
  process.exit(0);
});
