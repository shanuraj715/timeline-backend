// Shared by routes/timelines.js (to compute/report a trashed timeline's
// purge date) and scripts/worker.js (the cron sweep that actually purges
// past it) — one constant so the two can never drift apart.
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
