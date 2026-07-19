import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import StorageProvider from "../models/StorageProvider.js";
import StorageJob from "../models/StorageJob.js";
import StorageJobFile from "../models/StorageJobFile.js";
import CmsMedia from "../models/CmsMedia.js";
import {
  createStorageProviderSchema,
  updateStorageProviderSchema,
  activateProviderSchema,
  orphanScanSchema,
  deleteOrphanFilesSchema,
} from "../lib/validation/storageProviders.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { encryptSecret, decryptSecret, maskSecret, MASK_PREFIX } from "../lib/crypto.js";
import { getStorageById, invalidateStorageCache } from "../lib/storage/index.js";

export const storageRouter = Router();

const NON_TERMINAL = { $nin: ["completed", "cancelled", "failed"] };

function serializeProvider(p) {
  return {
    id: p._id.toString(),
    name: p.name,
    type: p.type,
    isActive: p.isActive,
    localPath: p.localPath,
    bucket: p.bucket,
    region: p.region,
    endpoint: p.endpoint,
    forcePathStyle: p.forcePathStyle,
    accessKeyId: p.accessKeyId,
    secretAccessKeyMasked: p.secretAccessKeyEncrypted ? maskSecret(decryptSecret(p.secretAccessKeyEncrypted)) : "",
    quotaBytes: p.quotaBytes,
    usageBytes: p.usageBytes,
    objectCount: p.objectCount,
    usageComputedAt: p.usageComputedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function serializeJob(j) {
  return {
    id: j._id.toString(),
    type: j.type,
    sourceProviderId: j.sourceProviderId?.toString() || null,
    targetProviderId: j.targetProviderId?.toString() || null,
    providerId: j.providerId?.toString() || null,
    mode: j.mode,
    status: j.status,
    totalFiles: j.totalFiles,
    totalBytes: j.totalBytes,
    processedFiles: j.processedFiles,
    processedBytes: j.processedBytes,
    failedFiles: j.failedFiles,
    orphanedKeys: j.orphanedKeys,
    errorMessage: j.errorMessage,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
  };
}

// ---- Providers ----

storageRouter.get(
  "/providers",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;
    await connectDB();
    const providers = await StorageProvider.find({}).sort({ createdAt: 1 });
    res.json({ providers: providers.map(serializeProvider) });
  })
);

storageRouter.post(
  "/providers",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    const data = parseJson(req, res, createStorageProviderSchema);
    if (!data) return;

    try {
      await connectDB();
      const { secretAccessKey, ...rest } = data;
      const provider = await StorageProvider.create({
        ...rest,
        isActive: false,
        secretAccessKeyEncrypted: secretAccessKey ? encryptSecret(secretAccessKey) : "",
      });
      res.status(201).json({ provider: serializeProvider(provider) });
    } catch (err) {
      serverError(res, err, "Failed to create storage provider");
    }
  })
);

storageRouter.patch(
  "/providers/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    const data = parseJson(req, res, updateStorageProviderSchema);
    if (!data) return;

    await connectDB();
    const provider = await StorageProvider.findById(req.params.id);
    if (!provider) return notFound(res, "Storage provider not found");

    const { secretAccessKey, ...rest } = data;
    Object.assign(provider, rest);
    // A masked value ("****ab12") round-tripped from the edit form means
    // "unchanged" — only a real new secret (or an explicit empty string,
    // clearing it) gets re-encrypted.
    if (secretAccessKey !== undefined && !secretAccessKey.startsWith(MASK_PREFIX)) {
      provider.secretAccessKeyEncrypted = secretAccessKey ? encryptSecret(secretAccessKey) : "";
    }
    await provider.save();
    invalidateStorageCache();

    res.json({ provider: serializeProvider(provider) });
  })
);

storageRouter.delete(
  "/providers/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    await connectDB();
    const provider = await StorageProvider.findById(req.params.id);
    if (!provider) return notFound(res, "Storage provider not found");
    if (provider.isActive) return badRequest(res, "Can't delete the active storage provider");

    const inUseByJob = await StorageJob.exists({
      status: NON_TERMINAL,
      $or: [{ sourceProviderId: provider._id }, { targetProviderId: provider._id }],
    });
    if (inUseByJob) return badRequest(res, "This provider is part of a migration in progress");

    await StorageProvider.deleteOne({ _id: provider._id });
    invalidateStorageCache();
    res.json({ ok: true });
  })
);

storageRouter.post(
  "/providers/:id/recalculate",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    await connectDB();
    const provider = await StorageProvider.findById(req.params.id);
    if (!provider) return notFound(res, "Storage provider not found");

    try {
      const driver = await getStorageById(provider._id);
      let cursor = null;
      let bytes = 0;
      let count = 0;
      do {
        const { items, cursor: next } = await driver.list({ cursor, limit: 1000 });
        bytes += items.reduce((sum, i) => sum + i.size, 0);
        count += items.length;
        cursor = next;
      } while (cursor);

      provider.usageBytes = bytes;
      provider.objectCount = count;
      provider.usageComputedAt = new Date();
      await provider.save();

      res.json({ provider: serializeProvider(provider) });
    } catch (err) {
      serverError(res, err, "Failed to recalculate storage usage");
    }
  })
);

// The main "switch active bucket" entry point. Called once with no `mode`:
// if the currently-active provider genuinely has no data, activation
// happens immediately. If it does, the response asks the client to re-call
// with a chosen `mode` instead of silently picking one — the admin must
// explicitly choose move vs copy, per the feature's requirement.
storageRouter.post(
  "/providers/:id/activate",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    const data = parseJson(req, res, activateProviderSchema);
    if (!data) return;

    await connectDB();
    const target = await StorageProvider.findById(req.params.id);
    if (!target) return notFound(res, "Storage provider not found");
    if (target.isActive) return badRequest(res, "This provider is already active");

    const existingJob = await StorageJob.findOne({ type: "migration", status: NON_TERMINAL });
    if (existingJob) return badRequest(res, "A storage migration is already in progress");

    const current = await StorageProvider.findOne({ isActive: true });

    // No currently-active provider (shouldn't happen post-bootstrap, but
    // defensive) or the current one is genuinely empty — nothing to move.
    let currentIsEmpty = true;
    if (current) {
      const currentDriver = await getStorageById(current._id);
      const { items } = await currentDriver.list({ limit: 1 });
      currentIsEmpty = items.length === 0;
    }

    if (!current || currentIsEmpty) {
      if (current) await StorageProvider.updateOne({ _id: current._id }, { $set: { isActive: false } });
      target.isActive = true;
      await target.save();
      invalidateStorageCache();
      return res.json({ activated: true, migrationStarted: false });
    }

    if (!data.mode) {
      return res.status(409).json({
        error: "The current storage provider has existing data — choose whether to move or copy it.",
        code: "MIGRATION_MODE_REQUIRED",
        currentProviderName: current.name,
      });
    }

    const job = await StorageJob.create({
      type: "migration",
      sourceProviderId: current._id,
      targetProviderId: target._id,
      mode: data.mode,
      status: "planning",
      startedByUserId: admin._id,
    });

    res.json({ activated: false, migrationStarted: true, job: serializeJob(job) });
  })
);

// ---- Jobs ----

storageRouter.get(
  "/jobs/active",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;
    await connectDB();
    const job = await StorageJob.findOne({ status: NON_TERMINAL }).sort({ startedAt: -1 });
    res.json({ job: job ? serializeJob(job) : null });
  })
);

storageRouter.get(
  "/jobs",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;
    await connectDB();
    const jobs = await StorageJob.find({}).sort({ startedAt: -1 }).limit(50);
    res.json({ jobs: jobs.map(serializeJob) });
  })
);

storageRouter.get(
  "/jobs/:id",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;
    await connectDB();
    const job = await StorageJob.findById(req.params.id);
    if (!job) return notFound(res, "Job not found");
    res.json({ job: serializeJob(job) });
  })
);

storageRouter.post(
  "/jobs/:id/cancel",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    await connectDB();
    const job = await StorageJob.findById(req.params.id);
    if (!job) return notFound(res, "Job not found");
    if (job.type !== "migration") return badRequest(res, "Only migrations can be cancelled");
    if (!["planning", "running", "verifying"].includes(job.status)) {
      return badRequest(res, `Can't cancel a job in "${job.status}" — it's past the point of no return`);
    }

    job.status = "cancelling";
    await job.save();
    res.json({ job: serializeJob(job) });
  })
);

// ---- Orphan files ----

storageRouter.post(
  "/orphan-scan",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    const data = parseJson(req, res, orphanScanSchema);
    if (!data) return;

    await connectDB();
    const existingJob = await StorageJob.findOne({ type: "orphan_scan", status: NON_TERMINAL });
    if (existingJob) return badRequest(res, "An orphan scan is already in progress");

    let providerId = data.providerId;
    if (!providerId) {
      const active = await StorageProvider.findOne({ isActive: true });
      if (!active) return badRequest(res, "No active storage provider");
      providerId = active._id;
    } else {
      const exists = await StorageProvider.exists({ _id: providerId });
      if (!exists) return notFound(res, "Storage provider not found");
    }

    const job = await StorageJob.create({
      type: "orphan_scan",
      providerId,
      status: "planning",
      startedByUserId: admin._id,
    });

    res.status(201).json({ job: serializeJob(job) });
  })
);

storageRouter.get(
  "/orphan-scan/latest",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;
    await connectDB();
    const job = await StorageJob.findOne({ type: "orphan_scan" }).sort({ startedAt: -1 });
    res.json({ job: job ? serializeJob(job) : null });
  })
);

storageRouter.post(
  "/orphan-files/delete",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.storage");
    if (!admin) return;

    const data = parseJson(req, res, deleteOrphanFilesSchema);
    if (!data) return;

    await connectDB();
    const provider = await StorageProvider.exists({ _id: data.providerId });
    if (!provider) return notFound(res, "Storage provider not found");

    try {
      const driver = await getStorageById(data.providerId);
      const results = await Promise.allSettled(data.keys.map((key) => driver.remove(key)));
      const failed = results.filter((r) => r.status === "rejected").length;

      await CmsMedia.deleteMany({ key: { $in: data.keys } });

      res.json({ ok: true, deleted: data.keys.length - failed, failed });
    } catch (err) {
      serverError(res, err, "Failed to delete orphaned files");
    }
  })
);
