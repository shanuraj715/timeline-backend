import StorageJob from "../../models/StorageJob.js";
import { runMigrationTick } from "./migrationWorker.js";
import { runOrphanScanTick } from "./orphanScanWorker.js";

const POLL_INTERVAL_MS = 5_000;
const TERMINAL_STATUSES = ["completed", "cancelled", "failed"];

let ticking = false;
let intervalHandle = null;

async function tick() {
  if (ticking) return; // a previous tick is still running (its own work loops up to ~25s) — don't overlap
  ticking = true;
  try {
    // One job at a time by design — routes/storage.js refuses to start a
    // new migration while one is already in flight, since two migrations
    // both trying to flip the active provider would race each other.
    const job = await StorageJob.findOne({ status: { $nin: TERMINAL_STATUSES } }).sort({ startedAt: 1 });
    if (!job) return;

    if (job.type === "migration") await runMigrationTick(job);
    else if (job.type === "orphan_scan") await runOrphanScanTick(job);
  } catch (err) {
    console.error("Storage worker tick failed:", err);
  } finally {
    ticking = false;
  }
}

/** Starts the background poll loop — called once from server.js at boot. Job state lives entirely in Mongo, so this is the whole of what "resume after a server restart" requires: just start polling again. */
export function startStorageWorker() {
  if (intervalHandle) return;
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  tick(); // don't wait out the first interval on a fresh boot
}
