import { connectDB } from "./db/connect.js";
import ActivityLog from "../models/ActivityLog.js";

async function write(kind, { userId = null, timelineId = null, action, targetType = null, targetId = null, ip = "", userAgent = "", metadata = {} }) {
  try {
    await connectDB();
    await ActivityLog.create({ kind, userId, timelineId, action, targetType, targetId, ip, userAgent, metadata });
  } catch (err) {
    // Logging must never break the request it's observing.
    console.error("Failed to write activity log:", err);
  }
}

/** Security-relevant events: logins, lockouts, session/CSRF failures. Never shown to family members. */
export function logSecurityEvent(fields) {
  return write("security", fields);
}

/** Family-facing activity feed: uploads, edits, invites, membership changes. */
export function logActivity(fields) {
  return write("activity", fields);
}
