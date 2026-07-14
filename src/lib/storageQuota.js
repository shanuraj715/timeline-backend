import Media from "../models/Media.js";
import { getPlatformSettings } from "./platformSettings.js";

/**
 * A timeline's effective storage quota is always computed live, never
 * stored as an absolute number on the Timeline doc — the free portion
 * tracks whatever the admin panel currently says, and only the purchased
 * add-on (positive from a user's own purchase, or an admin's direct
 * override — see routes/admin.js's PATCH .../storage, which can set this
 * negative to give one timeline a smaller-than-default quota) is a fixed
 * delta. This is also why an old timeline that predates this feature shows
 * the current free default instead of 0: it has purchasedStorageBytes: 0
 * (schema default) and no stale absolute number to have gotten stuck at.
 */
export async function getTimelineStorageQuota(timeline) {
  const settings = await getPlatformSettings();
  return settings.freeStorageBytesPerTimeline + (timeline.purchasedStorageBytes || 0);
}

export async function getTimelineUsedBytes(timelineId) {
  const rows = await Media.aggregate([
    { $match: { timelineId, deletedAt: null } },
    { $group: { _id: null, total: { $sum: "$size" } } },
  ]);
  return rows[0]?.total || 0;
}

export function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}
