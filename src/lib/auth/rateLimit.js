// In-memory sliding-window rate limiter, keyed by IP + bucket name.
// Protects auth endpoints from credential-stuffing across many accounts,
// on top of the per-account progressive lockout in lib/auth/lockout.js.
//
// Single-instance only by design (state lives in process memory) — fine for
// a self-hosted family app behind one Node process; the place to swap in a
// Redis-backed limiter if ever scaled out to multiple instances.

const buckets = new Map();

function sweep(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt < now) buckets.delete(key);
  }
}

/**
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
 */
export function rateLimit(key, { limit = 20, windowMs = 60_000 } = {}) {
  const now = Date.now();
  if (buckets.size > 5000) sweep(now);

  let entry = buckets.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(key, entry);
  }

  entry.count += 1;
  const allowed = entry.count <= limit;
  return { allowed, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}
