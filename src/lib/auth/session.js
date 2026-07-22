import crypto from "crypto";
import Session from "../../models/Session.js";

const REMEMBER_ME_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 1 day safety net for session-only cookies

export function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession({ userId, device, userAgent, ip, rememberMe }) {
  const { token, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + (rememberMe ? REMEMBER_ME_TTL_MS : DEFAULT_TTL_MS));

  const session = await Session.create({
    userId,
    refreshTokenHash: hash,
    device,
    userAgent,
    ip,
    rememberMe,
    expiresAt,
  });

  return { token, session };
}

/**
 * Validates a presented refresh token and rotates it.
 * Returns { session, token } on success.
 * Returns { reused: true, userId } if the token was already rotated (theft signal) —
 * caller should revoke the whole session family and force re-login.
 * Returns null if the token is unknown/expired/revoked.
 */
export async function rotateRefreshToken(presentedToken) {
  const presentedHash = hashToken(presentedToken);

  const current = await Session.findOne({ refreshTokenHash: presentedHash, revoked: false });
  if (current) {
    if (current.expiresAt.getTime() < Date.now()) return null;

    const { token, hash } = generateRefreshToken();
    current.previousTokenHash = current.refreshTokenHash;
    current.refreshTokenHash = hash;
    current.lastUsedAt = new Date();
    current.expiresAt = new Date(
      Date.now() + (current.rememberMe ? REMEMBER_ME_TTL_MS : DEFAULT_TTL_MS)
    );
    await current.save();

    return { session: current, token };
  }

  // Not a current token — check if it's a previously-rotated (replayed) token.
  const stale = await Session.findOne({ previousTokenHash: presentedHash });
  if (stale) {
    await Session.updateMany(
      { userId: stale.userId, revoked: false },
      { $set: { revoked: true, revokedReason: "refresh_token_reuse_detected" } }
    );
    return { reused: true, userId: stale.userId };
  }

  return null;
}

export async function revokeSession(sessionId) {
  await Session.updateOne(
    { _id: sessionId },
    { $set: { revoked: true, revokedReason: "logout" } }
  );
}

export async function revokeSessionByToken(rawToken) {
  const hash = hashToken(rawToken);
  await Session.updateOne(
    { refreshTokenHash: hash },
    { $set: { revoked: true, revokedReason: "logout" } }
  );
}

// `exceptSessionId` is what powers "sign out all other devices" (see
// routes/auth.js's POST /sessions/revoke-others) — the plain logout-
// everywhere path (routes/auth.js's POST /logout) doesn't pass it, since
// that one's supposed to end the current session too.
export async function revokeAllSessionsForUser(userId, reason = "logout_everywhere", { exceptSessionId } = {}) {
  const filter = { userId, revoked: false };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  await Session.updateMany(filter, { $set: { revoked: true, revokedReason: reason } });
}

export async function listActiveSessions(userId) {
  return Session.find({ userId, revoked: false, expiresAt: { $gt: new Date() } }).sort({
    lastUsedAt: -1,
  });
}
