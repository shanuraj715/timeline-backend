import User from "../models/User.js";
import ThemeUnlock from "../models/ThemeUnlock.js";

/**
 * Ensures a theme is usable on a timeline — free themes and themes
 * already unlocked for this timeline are a no-op; anything else charges
 * the acting user's own credit balance and records a permanent
 * per-(timeline, theme) unlock, per the site owner's explicit design:
 * one purchase unlocks a theme for that timeline forever, chargeable to
 * whichever member actually clicks the button.
 *
 * No DB transaction (would need a replica-set-backed Mongo, which isn't
 * guaranteed here) — instead, a duplicate-key race on ThemeUnlock's
 * unique (timelineId, themeId) index is treated as "someone else already
 * unlocked it a moment ago" and refunds the credits just charged.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function ensureThemeUnlocked(timelineId, theme, actingUser) {
  if (theme.priceCredits === 0) return { ok: true };

  const existing = await ThemeUnlock.findOne({ timelineId, themeId: theme._id });
  if (existing) return { ok: true };

  const freshUser = await User.findById(actingUser._id);
  if (freshUser.credits < theme.priceCredits) {
    return { ok: false, error: "Not enough credits to unlock this theme" };
  }

  freshUser.credits -= theme.priceCredits;
  await freshUser.save();

  try {
    await ThemeUnlock.create({
      timelineId,
      themeId: theme._id,
      purchasedByUserId: actingUser._id,
      creditsSpent: theme.priceCredits,
    });
  } catch (err) {
    if (err?.code === 11000) {
      freshUser.credits += theme.priceCredits;
      await freshUser.save();
      return { ok: true };
    }
    throw err;
  }

  return { ok: true };
}
