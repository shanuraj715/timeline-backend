// Dynamic storage resolution — replaces the old "one driver, fixed at
// process startup from STORAGE_DRIVER env var" setup now that providers are
// admin-configurable at runtime (see models/StorageProvider.js). Every call
// site does `const storage = await getStorage();` instead of importing a
// static singleton, so switching the active provider takes effect for the
// very next request with no server restart.
//
// Keys are logical paths like "originals/{timelineId}/{YYYYMMDD}/{mediaId}.jpg"
// — never a full filesystem path or bucket URL — so swapping providers
// never touches anything stored in Media/Theme/CmsMedia documents. That's
// also exactly why a migration between providers never breaks a file link:
// the key a document points to doesn't change, only which provider it
// currently resolves against.

import { createLocalDriver } from "./localDriver.js";
import { createS3Driver } from "./s3Driver.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import StorageProvider from "../../models/StorageProvider.js";
import { connectDB } from "../db/connect.js";

const driverCache = new Map(); // providerId (string) -> driver instance
let activeProviderId = null; // cached id of the currently-active provider

/** Call after any create/update/delete/activate on StorageProvider so stale credentials/paths are never served from cache. */
export function invalidateStorageCache() {
  driverCache.clear();
  activeProviderId = null;
}

function buildDriver(provider) {
  if (provider.type === "local") {
    return createLocalDriver({ basePath: provider.localPath });
  }
  return createS3Driver({
    region: provider.region,
    endpoint: provider.endpoint,
    forcePathStyle: provider.forcePathStyle,
    bucket: provider.bucket,
    accessKeyId: provider.accessKeyId,
    secretAccessKey: provider.secretAccessKeyEncrypted ? decryptSecret(provider.secretAccessKeyEncrypted) : "",
  });
}

/** Returns the driver for a specific provider (used by migrations, which need both the source and target at once — neither is necessarily "active"). */
export async function getStorageById(providerId) {
  const key = String(providerId);
  if (driverCache.has(key)) return driverCache.get(key);

  await connectDB();
  const provider = await StorageProvider.findById(providerId);
  if (!provider) throw new Error(`Storage provider ${providerId} not found`);

  const driver = buildDriver(provider);
  driverCache.set(key, driver);
  return driver;
}

/** Returns the driver for whichever provider is currently active — this is what every route outside the storage-migration system should use. */
export async function getStorage() {
  if (activeProviderId) return getStorageById(activeProviderId);

  await connectDB();
  const active = await StorageProvider.findOne({ isActive: true });
  if (!active) {
    throw new Error(
      "No active storage provider configured. This should be impossible after bootstrapDefaultProvider() runs at server startup."
    );
  }
  activeProviderId = active._id.toString();
  return getStorageById(activeProviderId);
}

/**
 * Runs once at server startup (see server.js). Existing self-hosted
 * deployments have no StorageProvider documents at all — without this,
 * they'd break on upgrade with "no active storage provider configured"
 * instead of continuing to work exactly as before, reading the same
 * STORAGE_DRIVER/STORAGE_LOCAL_PATH/S3_* env vars they always did.
 */
export async function bootstrapDefaultProvider() {
  await connectDB();
  const existing = await StorageProvider.countDocuments({});
  if (existing > 0) return;

  const driver = process.env.STORAGE_DRIVER || "local";
  if (driver === "s3") {
    await StorageProvider.create({
      name: "Default S3",
      type: "s3",
      isActive: true,
      bucket: process.env.S3_BUCKET || "",
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || "",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKeyEncrypted: process.env.S3_SECRET_ACCESS_KEY
        ? encryptSecret(process.env.S3_SECRET_ACCESS_KEY)
        : "",
    });
  } else {
    await StorageProvider.create({
      name: "Local disk",
      type: "local",
      isActive: true,
      localPath: process.env.STORAGE_LOCAL_PATH || "./storage",
    });
  }
}

/** Pure key-naming helper — unchanged by the provider refactor, since keys never encode which provider they live in. */
export function buildStorageKey({ timelineId, dayKey, mediaId, extension, variant }) {
  const folder = variant === "thumbnail" ? "thumbnails" : variant === "preview" ? "previews" : "originals";
  return `${folder}/${timelineId}/${dayKey}/${mediaId}${extension}`;
}
