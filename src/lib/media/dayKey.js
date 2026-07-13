// Day boundaries are computed in UTC for a simple, deterministic key that's
// consistent regardless of where the server or any given viewer is located.
// (A future improvement could make this per-timeline-timezone configurable.)
export function dayKeyFor(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
