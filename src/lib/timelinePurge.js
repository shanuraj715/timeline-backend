import Media from "../models/Media.js";
import Timeline from "../models/Timeline.js";
import Membership from "../models/Membership.js";
import DaySummary from "../models/DaySummary.js";
import Invitation from "../models/Invitation.js";
import ThemeUnlock from "../models/ThemeUnlock.js";
import TimelineThemeOverride from "../models/TimelineThemeOverride.js";
import StoragePurchase from "../models/StoragePurchase.js";
import { getStorage } from "./storage/index.js";

// The one place that knows how to permanently erase everything a timeline
// owns — every model with a timelineId gets cleaned up here except
// ActivityLog, which is left alone deliberately as an audit trail: it
// should still be possible to answer "who deleted timeline X and when"
// after the timeline itself is gone, the same way a security log isn't
// expected to erase its own history just because the thing it logged no
// longer exists.
//
// Storage removal is best-effort (Promise.allSettled, failures logged but
// not thrown) — a transient S3 blip on one file must never block the rest
// of a deletion the user was told is permanent and irreversible. Shared by
// routes/timelines.js's DELETE /:slug (called immediately — there is no
// timeline restore feature anywhere in this app, so there is nothing to
// wait for) and scripts/worker.js's trash sweep (a safety net for any
// timeline that somehow ends up with deletedAt set but not yet purged).
export async function purgeTimeline(timeline) {
  const storage = await getStorage();

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
  await Invitation.deleteMany({ timelineId: timeline._id });
  await ThemeUnlock.deleteMany({ timelineId: timeline._id });
  await TimelineThemeOverride.deleteMany({ timelineId: timeline._id });
  await StoragePurchase.deleteMany({ timelineId: timeline._id });
  await Timeline.deleteOne({ _id: timeline._id });

  return { mediaCount: mediaItems.length };
}
