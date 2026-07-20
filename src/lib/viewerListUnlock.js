import User from "../models/User.js";
import ViewerListUnlock from "../models/ViewerListUnlock.js";

/**
 * Unlocks the "who viewed this timeline" list, permanently, for a price
 * snapshot from PlatformSettings.viewerListUnlockPriceCredits. Mirrors
 * lib/themeUnlock.js's ensureThemeUnlocked exactly (see that file's
 * comment for why there's no DB transaction): a duplicate-key race on
 * ViewerListUnlock's unique timelineId index is treated as "someone else
 * already unlocked it a moment ago" and refunds the credits just charged.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function unlockViewerList(timelineId, priceCredits, actingUser) {
  const existing = await ViewerListUnlock.findOne({ timelineId });
  if (existing) return { ok: true };

  const freshUser = await User.findById(actingUser._id);
  if (freshUser.credits < priceCredits) {
    return { ok: false, error: "Not enough credits to unlock the viewer list" };
  }

  freshUser.credits -= priceCredits;
  await freshUser.save();

  try {
    await ViewerListUnlock.create({ timelineId, purchasedByUserId: actingUser._id, creditsSpent: priceCredits });
  } catch (err) {
    if (err?.code === 11000) {
      freshUser.credits += priceCredits;
      await freshUser.save();
      return { ok: true };
    }
    throw err;
  }

  return { ok: true };
}
