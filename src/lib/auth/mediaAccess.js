import Media from "../../models/Media.js";
import Membership from "../../models/Membership.js";
import { verifyMediaToken } from "./mediaToken.js";
import { getCurrentUser } from "./guards.js";
import { permissions } from "../rbac/permissions.js";

/**
 * Authorizes a request for one media item, either via its short-TTL signed
 * token (fast path, no Membership lookup — see lib/auth/mediaToken.js) or,
 * if that's missing/expired, by falling back to a full cookie-session +
 * Membership check so direct/bookmarked links still work correctly.
 * Returns { media } on success, or null.
 */
export async function authorizeMediaAccess(mediaId, token, req) {
  // Deliberately does NOT filter out soft-deleted media: the Trash tab
  // needs to preview thumbnails/files of items before a user restores or
  // permanently deletes them. Trashed items are only reachable via a token
  // minted for a member who already passed a membership+role check when
  // the trash listing was served (see routes/timelines' trash listing), or
  // via the session-fallback viewMedia permission check below — trashed
  // state doesn't need stricter access than normal media, just hidden
  // from the default view.
  const media = await Media.findOne({ _id: mediaId });
  if (!media) return null;

  if (token) {
    const payload = verifyMediaToken(token, mediaId);
    if (payload && payload.timelineId === media.timelineId.toString()) {
      return { media };
    }
  }

  const user = await getCurrentUser(req);
  if (!user) return null;

  const membership = await Membership.findOne({
    timelineId: media.timelineId,
    userId: user._id,
    status: "active",
  });
  if (!membership || !permissions.viewMedia(membership.role)) return null;

  return { media };
}
