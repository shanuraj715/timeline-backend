// Relative imports so this module works both when imported by Express route
// modules and when imported directly by scripts/worker.js via plain Node.
import DaySummary from "../../models/DaySummary.js";
import Media from "../../models/Media.js";

/**
 * Recomputes the DaySummary row for one (timeline, day) from Media —
 * the source of truth — and upserts it, or removes the row if the day is
 * now empty. Called after any Media transition that could change what a
 * day node shows: ready, soft-delete, restore, or favorite toggle.
 */
export async function syncDaySummary(timelineId, dayKey) {
  const stats = await Media.aggregate([
    {
      $match: {
        timelineId,
        dayKey,
        deletedAt: null,
        processingStatus: "ready",
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        favoriteCount: { $sum: { $cond: ["$favorite", 1, 0] } },
        // Prefer a favorited item as the cover; otherwise the most recently captured one.
        cover: { $max: { favorite: "$favorite", captureDate: "$captureDate", id: "$_id" } },
        date: { $min: "$captureDate" },
      },
    },
  ]);

  const stat = stats[0];

  if (!stat || stat.count === 0) {
    await DaySummary.deleteOne({ timelineId, dayKey });
    return;
  }

  await DaySummary.findOneAndUpdate(
    { timelineId, dayKey },
    {
      $set: {
        date: stat.date,
        mediaCount: stat.count,
        favoriteCount: stat.favoriteCount,
        coverMediaId: stat.cover.id,
      },
    },
    { upsert: true }
  );
}
