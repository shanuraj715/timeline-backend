import { getPlatformSettings } from "./platformSettings.js";

/**
 * A timeline's effective storage quota is always computed live, never
 * stored as an absolute number on the Timeline doc — the free portion
 * tracks whatever the admin panel currently says, and only the purchased
 * add-on (if any) is a fixed historical grant. This is also why an old
 * timeline that predates this feature shows the current free default
 * instead of 0: it has purchasedStorageBytes: 0 (schema default) and no
 * stale absolute number to have gotten stuck at.
 */
export async function getTimelineStorageQuota(timeline) {
  const settings = await getPlatformSettings();
  return settings.freeStorageBytesPerTimeline + (timeline.purchasedStorageBytes || 0);
}
