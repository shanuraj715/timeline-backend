import StorageJob from "../../models/StorageJob.js";
import StorageJobFile from "../../models/StorageJobFile.js";
import StorageProvider from "../../models/StorageProvider.js";
import { getStorageById, invalidateStorageCache } from "./index.js";

const LIST_PAGE_SIZE = 1000;
const TRANSFER_CONCURRENCY = 8;
const TICK_BUDGET_MS = 25_000; // leaves headroom under the ~30s poll interval so a tick always yields back
const MAX_VERIFY_PASSES = 5; // bounds the plan<->verify convergence loop — see runVerifying()'s comment
const MAX_ATTEMPTS_PER_FILE = 3;

function now() {
  return Date.now();
}

async function refetch(jobId) {
  return StorageJob.findById(jobId);
}

/** One tick of work for a single migration job — called repeatedly by the worker loop until the job reaches a terminal status. Re-entrant/idempotent at every step so a server restart mid-job just resumes here. */
export async function runMigrationTick(jobDoc) {
  let job = jobDoc;
  switch (job.status) {
    case "planning":
      return runPlanning(job);
    case "running":
      return runTransferring(job);
    case "verifying":
      return runVerifying(job);
    case "cutover":
      return runCutover(job);
    case "cleanup":
      return runCleanup(job);
    case "cancelling":
      return runCancelling(job);
    default:
      return; // completed / cancelled / failed — nothing to do
  }
}

async function markFailed(job, err) {
  console.error(`Storage migration job ${job._id} failed:`, err);
  await StorageJob.updateOne(
    { _id: job._id },
    { $set: { status: "failed", errorMessage: err?.message || String(err), completedAt: new Date() } }
  );
}

/** Lists everything at `source` not yet tracked as a StorageJobFile row for this job, inserting one row per new key — resumable across ticks via job.listCursor, and safe to re-run (unique index on jobId+key makes re-inserting a no-op). */
async function enumerateSource(job, source) {
  let cursor = job.listCursor;
  let totalFiles = job.totalFiles;
  let totalBytes = job.totalBytes;
  const start = now();

  while (now() - start < TICK_BUDGET_MS) {
    const { items, cursor: nextCursor } = await source.list({ cursor, limit: LIST_PAGE_SIZE });

    if (items.length > 0) {
      const ops = items.map((item) => ({
        updateOne: {
          filter: { jobId: job._id, key: item.key },
          update: { $setOnInsert: { jobId: job._id, key: item.key, size: item.size, status: "pending" } },
          upsert: true,
        },
      }));
      await StorageJobFile.bulkWrite(ops, { ordered: false });
      totalFiles += items.length;
      totalBytes += items.reduce((sum, i) => sum + i.size, 0);
    }

    cursor = nextCursor;
    await StorageJob.updateOne({ _id: job._id }, { $set: { listCursor: cursor, totalFiles, totalBytes } });

    if (!cursor) return true; // fully enumerated
  }
  return false; // ran out of time budget this tick — resume next tick from listCursor
}

async function runPlanning(job) {
  try {
    const source = await getStorageById(job.sourceProviderId);
    const done = await enumerateSource(job, source);
    if (!done) return; // resumes next tick

    await StorageJob.updateOne({ _id: job._id }, { $set: { status: "running", listCursor: null } });
  } catch (err) {
    await markFailed(job, err);
  }
}

async function transferOne(job, source, target, fileDoc) {
  try {
    const { stream } = await source.createReadStream(fileDoc.key, null);
    await target.writeStream(fileDoc.key, stream);
    await StorageJobFile.updateOne(
      { _id: fileDoc._id },
      { $set: { status: "done", copiedAt: new Date() }, $inc: { attempts: 1 } }
    );
    await StorageJob.updateOne(
      { _id: job._id },
      { $inc: { processedFiles: 1, processedBytes: fileDoc.size } }
    );
  } catch (err) {
    const attempts = fileDoc.attempts + 1;
    const permanentlyFailed = attempts >= MAX_ATTEMPTS_PER_FILE;
    await StorageJobFile.updateOne(
      { _id: fileDoc._id },
      { $set: { status: permanentlyFailed ? "failed" : "pending", error: String(err?.message || err), attempts } }
    );
    if (permanentlyFailed) {
      await StorageJob.updateOne({ _id: job._id }, { $inc: { failedFiles: 1 } });
    }
  }
}

async function isCancelRequested(jobId) {
  const fresh = await StorageJob.findById(jobId).select("status");
  return fresh?.status === "cancelling";
}

async function runTransferring(job) {
  try {
    const source = await getStorageById(job.sourceProviderId);
    const target = await getStorageById(job.targetProviderId);
    const start = now();

    while (now() - start < TICK_BUDGET_MS) {
      if (await isCancelRequested(job._id)) return; // next tick's runCancelling() takes over

      const batch = await StorageJobFile.find({ jobId: job._id, status: "pending" }).limit(TRANSFER_CONCURRENCY);
      if (batch.length === 0) break;

      await Promise.all(batch.map((f) => transferOne(job, source, target, f)));
    }

    const remaining = await StorageJobFile.countDocuments({ jobId: job._id, status: "pending" });
    if (remaining > 0) return; // resumes next tick

    await StorageJob.updateOne({ _id: job._id }, { $set: { status: "verifying" } });
  } catch (err) {
    await markFailed(job, err);
  }
}

/**
 * Files keep being written to the source (the still-active provider)
 * throughout the transfer phase, so a straight one-pass copy can miss
 * anything uploaded during the migration window. This re-lists the source
 * looking for keys with no StorageJobFile row yet; if it finds any, they're
 * queued and the job goes back to "running" to copy them, then verifies
 * again. Capped at MAX_VERIFY_PASSES rather than looping until a perfectly
 * empty diff — with real traffic that could never converge — so cutover is
 * guaranteed to happen eventually, accepting a small residual-race window
 * documented in the admin UI rather than blocking indefinitely.
 */
async function runVerifying(job) {
  try {
    const verifyPasses = (job.verifyPasses || 0) + 1;
    if (verifyPasses > MAX_VERIFY_PASSES) {
      await StorageJob.updateOne({ _id: job._id }, { $set: { status: "cutover" } });
      return;
    }

    const source = await getStorageById(job.sourceProviderId);
    const existingKeys = new Set(
      (await StorageJobFile.find({ jobId: job._id }).select("key")).map((f) => f.key)
    );

    let cursor = null;
    let foundNew = false;
    do {
      const { items, cursor: nextCursor } = await source.list({ cursor, limit: LIST_PAGE_SIZE });
      const newItems = items.filter((i) => !existingKeys.has(i.key));
      if (newItems.length > 0) {
        foundNew = true;
        await StorageJobFile.bulkWrite(
          newItems.map((item) => ({
            updateOne: {
              filter: { jobId: job._id, key: item.key },
              update: { $setOnInsert: { jobId: job._id, key: item.key, size: item.size, status: "pending" } },
              upsert: true,
            },
          })),
          { ordered: false }
        );
        await StorageJob.updateOne(
          { _id: job._id },
          {
            $inc: {
              totalFiles: newItems.length,
              totalBytes: newItems.reduce((sum, i) => sum + i.size, 0),
            },
          }
        );
      }
      cursor = nextCursor;
    } while (cursor);

    await StorageJob.updateOne(
      { _id: job._id },
      { $set: { status: foundNew ? "running" : "cutover" }, $inc: { verifyPasses: 1 } }
    );
  } catch (err) {
    await markFailed(job, err);
  }
}

async function runCutover(job) {
  try {
    await StorageProvider.updateOne({ _id: job.sourceProviderId }, { $set: { isActive: false } });
    await StorageProvider.updateOne({ _id: job.targetProviderId }, { $set: { isActive: true } });
    invalidateStorageCache();

    const [totalFiles, totalBytes] = await Promise.all([
      StorageJobFile.countDocuments({ jobId: job._id, status: "done" }),
      StorageJobFile.aggregate([
        { $match: { jobId: job._id, status: "done" } },
        { $group: { _id: null, sum: { $sum: "$size" } } },
      ]).then((r) => r[0]?.sum || 0),
    ]);
    await StorageProvider.updateOne(
      { _id: job.targetProviderId },
      { $set: { usageBytes: totalBytes, objectCount: totalFiles, usageComputedAt: new Date() } }
    );

    if (job.mode === "move") {
      await StorageJob.updateOne({ _id: job._id }, { $set: { status: "cleanup" } });
    } else {
      await StorageJob.updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: new Date() } });
    }
  } catch (err) {
    await markFailed(job, err);
  }
}

async function runCleanup(job) {
  try {
    const source = await getStorageById(job.sourceProviderId);
    const start = now();

    while (now() - start < TICK_BUDGET_MS) {
      const batch = await StorageJobFile.find({ jobId: job._id, status: "done", cleanedUp: { $ne: true } }).limit(
        TRANSFER_CONCURRENCY
      );
      if (batch.length === 0) break;

      await Promise.all(
        batch.map(async (f) => {
          await source.remove(f.key).catch((err) => console.error(`Failed to remove source key ${f.key}:`, err));
          await StorageJobFile.updateOne({ _id: f._id }, { $set: { cleanedUp: true } });
        })
      );
    }

    const remaining = await StorageJobFile.countDocuments({
      jobId: job._id,
      status: "done",
      cleanedUp: { $ne: true },
    });
    if (remaining > 0) return; // resumes next tick

    await StorageJob.updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: new Date() } });
  } catch (err) {
    await markFailed(job, err);
  }
}

/** Deletes every file this job successfully copied to the target — and only those, leaving anything the target bucket already had untouched. The source (still active throughout) is never touched by a cancel. */
async function runCancelling(job) {
  try {
    const target = await getStorageById(job.targetProviderId);
    const start = now();

    while (now() - start < TICK_BUDGET_MS) {
      const batch = await StorageJobFile.find({ jobId: job._id, status: "done", cleanedUp: { $ne: true } }).limit(
        TRANSFER_CONCURRENCY
      );
      if (batch.length === 0) break;

      await Promise.all(
        batch.map(async (f) => {
          await target.remove(f.key).catch((err) => console.error(`Failed to remove target key ${f.key}:`, err));
          await StorageJobFile.updateOne({ _id: f._id }, { $set: { cleanedUp: true } });
        })
      );
    }

    const remaining = await StorageJobFile.countDocuments({
      jobId: job._id,
      status: "done",
      cleanedUp: { $ne: true },
    });
    if (remaining > 0) return; // resumes next tick

    await StorageJob.updateOne({ _id: job._id }, { $set: { status: "cancelled", completedAt: new Date() } });
  } catch (err) {
    await markFailed(job, err);
  }
}
