import crypto from "crypto";

// Short-TTL, self-issued signed tokens for media access — minted once when
// a request has already passed a real Membership DB check (e.g. the media
// list/day API), then attached to every <img>/<video> src so the file and
// thumbnail route handlers can authorize a flood of subsequent requests
// (a video scrub can be dozens of range requests) by signature alone,
// without a DB round-trip per chunk. Same idea as an S3 pre-signed URL.

const DEFAULT_TTL_SECONDS = 15 * 60;

function getSecret() {
  const secret = process.env.MEDIA_TOKEN_SECRET;
  if (!secret) throw new Error("Missing MEDIA_TOKEN_SECRET environment variable.");
  return secret;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// `userId` is optional — a guest (public timeline, no session) has none.
// authorizeMediaAccess()'s fast path only ever checks the signature and
// that payload.timelineId matches the requested media's own timeline; the
// userId field is informational only, never compared against anything, so
// there's nothing else to special-case for an anonymous viewer here.
export function signMediaToken({ mediaId, timelineId, userId }, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const payload = {
    mediaId: mediaId.toString(),
    timelineId: timelineId.toString(),
    userId: userId ? userId.toString() : null,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", getSecret()).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export function verifyMediaToken(token, mediaId) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, signature] = token.split(".");

  const expectedSignature = crypto
    .createHmac("sha256", getSecret())
    .update(payloadB64)
    .digest("base64url");

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (mediaId && payload.mediaId !== mediaId.toString()) return null;

  return payload;
}
