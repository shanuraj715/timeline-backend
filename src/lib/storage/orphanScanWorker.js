import StorageJob from "../../models/StorageJob.js";
import Media from "../../models/Media.js";
import Theme from "../../models/Theme.js";
import CmsMedia from "../../models/CmsMedia.js";
import Page from "../../models/Page.js";
import FooterColumn from "../../models/FooterColumn.js";
import { getStorageById } from "./index.js";

const LIST_PAGE_SIZE = 1000;
const TICK_BUDGET_MS = 25_000;

function now() {
  return Date.now();
}

/** One tick of work for an orphan-scan job — mirrors migrationWorker's shape (resumable via listCursor, bounded per-tick by a time budget). */
export async function runOrphanScanTick(job) {
  if (job.status === "planning") return runListing(job);
  if (job.status === "running") return runReconcile(job);
  // completed / cancelled / failed — nothing to do
}

async function markFailed(job, err) {
  console.error(`Orphan scan job ${job._id} failed:`, err);
  await StorageJob.updateOne(
    { _id: job._id },
    { $set: { status: "failed", errorMessage: err?.message || String(err), completedAt: new Date() } }
  );
}

// Listed keys accumulate directly on the job document rather than a
// per-key collection (unlike migration's StorageJobFile) — an orphan scan
// only ever needs the final "is this key referenced anywhere" answer, not
// per-file retry/resume state, so there's nothing worth a second
// collection for. Capped implicitly by MongoDB's 16MB document size (at
// ~100 bytes/entry that's on the order of 100k+ objects, comfortably past
// what a real orphan list looks like in practice).
async function runListing(job) {
  try {
    const provider = await getStorageById(job.providerId);
    let cursor = job.listCursor;
    const start = now();
    let scanned = job.scannedKeys || [];

    while (now() - start < TICK_BUDGET_MS) {
      const { items, cursor: nextCursor } = await provider.list({ cursor, limit: LIST_PAGE_SIZE });
      scanned = scanned.concat(items);
      cursor = nextCursor;

      await StorageJob.updateOne(
        { _id: job._id },
        { $set: { listCursor: cursor, scannedKeys: scanned, totalFiles: scanned.length } }
      );

      if (!cursor) {
        await StorageJob.updateOne({ _id: job._id }, { $set: { status: "running" } });
        return;
      }
    }
    // ran out of time budget this tick — resumes next tick from listCursor
  } catch (err) {
    await markFailed(job, err);
  }
}

/** A CmsMedia file counts as "in use" only if its URL still appears in some Page's content or FooterColumn's HTML — having been uploaded once isn't proof it's still referenced (an editor may have since removed it from the content). */
async function inUseCmsMediaFilenames() {
  const [pages, columns] = await Promise.all([
    Page.find({}).select("content"),
    FooterColumn.find({ contentType: "html" }).select("html"),
  ]);
  const haystack = [...pages.map((p) => p.content), ...columns.map((c) => c.html)].join("\n");

  const inUse = new Set();
  const re = /\/api\/cms\/media\/([0-9a-f-]+\.[a-z0-9]+)/gi;
  let match;
  while ((match = re.exec(haystack))) {
    inUse.add(match[1]);
  }
  return inUse;
}

async function runReconcile(job) {
  try {
    const [mediaDocs, themeDocs, cmsMediaDocs, inUseCmsFilenames] = await Promise.all([
      Media.find({}).select("storageKey thumbnailKey previewKey"),
      Theme.find({ imageKey: { $ne: null } }).select("imageKey"),
      CmsMedia.find({}).select("key filename"),
      inUseCmsMediaFilenames(),
    ]);

    const inUseKeys = new Set();
    for (const m of mediaDocs) {
      if (m.storageKey) inUseKeys.add(m.storageKey);
      if (m.thumbnailKey) inUseKeys.add(m.thumbnailKey);
      if (m.previewKey) inUseKeys.add(m.previewKey);
    }
    for (const t of themeDocs) inUseKeys.add(t.imageKey);
    for (const c of cmsMediaDocs) {
      if (inUseCmsFilenames.has(c.filename)) inUseKeys.add(c.key);
    }
    // theme-assets/ image keys aren't individually enumerable from the
    // Theme doc beyond imageKey itself, which is already covered above.

    const scanned = job.scannedKeys || [];
    const orphaned = scanned.filter((item) => !inUseKeys.has(item.key));

    await StorageJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "completed",
          orphanedKeys: orphaned,
          completedAt: new Date(),
        },
        $unset: { scannedKeys: "" },
      }
    );
  } catch (err) {
    await markFailed(job, err);
  }
}
