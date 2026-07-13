// Standalone background worker — runs as its own long-lived Node process
// (see docker-compose.yml / `npm run worker`), separate from the Express
// web process. Handles the two things that must never block an HTTP
// response and must survive a process restart:
//   1. Video thumbnail generation (ffmpeg frame extraction + duration probe)
//   2. Permanently purging trash (media + timelines) older than 30 days
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
import Membership from "../src/models/Membership.js";
import DaySummary from "../src/models/DaySummary.js";
import { storage, buildStorageKey } from "../src/lib/storage/index.js";
import { probeVideo, extractVideoFrame } from "../src/lib/media/video.js";
import { generateImageDerivatives } from "../src/lib/media/thumbnail.js";
import { syncDaySummary } from "../src/lib/media/daySummary.js";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 15000);
const TRASH_SWEEP_CRON = process.env.WORKER_TRASH_SWEEP_CRON || "0 3 * * *";
const MAX_ATTEMPTS = 5;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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

  for (const media of expired) {
    await Promise.allSettled(
      [media.storageKey, media.thumbnailKey, media.previewKey]
        .filter(Boolean)
        .map((key) => storage.remove(key))
    );
    await Media.deleteOne({ _id: media._id });
  }
  if (expired.length) console.log(`[worker] purged ${expired.length} trashed media item(s)`);
}

async function purgeExpiredTimelines() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);
  const expired = await Timeline.find({ deletedAt: { $ne: null, $lt: cutoff } });

  for (const timeline of expired) {
    const mediaItems = await Media.find({ timelineId: timeline._id });
    for (const media of mediaItems) {
      await Promise.allSettled(
        [media.storageKey, media.thumbnailKey, media.previewKey]
          .filter(Boolean)
          .map((key) => storage.remove(key))
      );
    }
    await Media.deleteMany({ timelineId: timeline._id });
    await DaySummary.deleteMany({ timelineId: timeline._id });
    await Membership.deleteMany({ timelineId: timeline._id });
    await Timeline.deleteOne({ _id: timeline._id });
    console.log(`[worker] permanently purged timeline ${timeline._id}`);
  }
}

async function trashSweep() {
  console.log("[worker] running trash sweep");
  await purgeExpiredMedia();
  await purgeExpiredTimelines();
}

async function main() {
  await connectDB();
  console.log("[worker] connected to MongoDB");

  await videoProcessingTick();
  setInterval(videoProcessingTick, POLL_INTERVAL_MS);

  cron.schedule(TRASH_SWEEP_CRON, () => {
    trashSweep().catch((err) => console.error("[worker] trash sweep failed:", err));
  });

  console.log(`[worker] polling for video jobs every ${POLL_INTERVAL_MS}ms; trash sweep "${TRASH_SWEEP_CRON}"`);
}

main().catch((err) => {
  console.error("[worker] fatal error:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await mongoose.connection.close();
  process.exit(0);
});
