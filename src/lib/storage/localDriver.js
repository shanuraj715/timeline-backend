import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

/**
 * Factory instead of a module-level singleton — lets a "local disk" and an
 * "S3/R2 bucket" provider exist side by side during a migration, each with
 * its own root path.
 * @param {{ basePath: string }} config
 */
export function createLocalDriver(config) {
  const ROOT = path.resolve(config.basePath || "./storage");

  function resolveKey(key) {
    const resolved = path.resolve(ROOT, key);
    // Defense in depth against a key ever containing "../" segments.
    if (!resolved.startsWith(ROOT)) throw new Error("Invalid storage key");
    return resolved;
  }

  async function write(key, buffer) {
    const filePath = resolveKey(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buffer);
  }

  /** Streams to disk without buffering the whole file in memory. */
  async function writeStream(key, readable) {
    const filePath = resolveKey(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(readable, fs.createWriteStream(filePath));
  }

  async function read(key) {
    return fsp.readFile(resolveKey(key));
  }

  async function exists(key) {
    try {
      await fsp.access(resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async function stat(key) {
    const s = await fsp.stat(resolveKey(key));
    return { size: s.size };
  }

  async function remove(key) {
    await fsp.rm(resolveKey(key), { force: true });
  }

  /**
   * @param {string} key
   * @param {{ start: number, end: number } | null} range
   * @returns {Promise<{ stream: import('fs').ReadStream, size: number, start: number, end: number }>}
   */
  async function createReadStream(key, range = null) {
    const filePath = resolveKey(key);
    const { size } = await stat(key);

    // A genuinely empty file (e.g. a stray .gitkeep swept up by a
    // migration/orphan scan listing every object in a bucket) has no valid
    // byte range at all — size - 1 would be -1, which fs.createReadStream
    // rejects. Media/theme uploads are never 0 bytes in normal use, so
    // this only ever came up once the migration system started reading
    // every object a bucket happens to contain.
    if (size === 0) {
      return { stream: Readable.from([]), size: 0, start: 0, end: 0 };
    }

    const start = range ? range.start : 0;
    const end = range ? Math.min(range.end, size - 1) : size - 1;

    const stream = fs.createReadStream(filePath, { start, end });
    return { stream, size, start, end };
  }

  async function walk(dir, out) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory vanished mid-walk (e.g. concurrent delete) — skip it
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, out);
      } else if (entry.isFile()) {
        out.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  }

  /**
   * Local disk has no native "continuation token" the way S3 does, so this
   * re-walks the whole tree and slices by sorted relative-path cursor each
   * call — O(n) per page rather than truly incremental, but disk walks
   * have no network latency, and this is only called a handful of times
   * per 1000 files (migration/orphan-scan planning phases), not per file.
   * @param {{ cursor?: string | null, limit?: number }} options
   * @returns {Promise<{ items: { key: string, size: number }[], cursor: string | null }>}
   */
  async function list({ cursor = null, limit = 1000 } = {}) {
    const all = [];
    await walk(ROOT, all);
    all.sort();

    const startIndex = cursor ? all.findIndex((p) => p > cursor) : 0;
    const slice = startIndex === -1 ? [] : all.slice(startIndex, startIndex + limit);

    const items = await Promise.all(
      slice.map(async (relPath) => {
        try {
          const s = await fsp.stat(path.join(ROOT, relPath));
          return { key: relPath, size: s.size };
        } catch {
          return null; // deleted between the walk and the stat — drop it
        }
      })
    );

    const filtered = items.filter(Boolean);
    const nextCursor = slice.length === limit && startIndex + limit < all.length ? slice[slice.length - 1] : null;
    return { items: filtered, cursor: nextCursor };
  }

  return { write, writeStream, read, exists, remove, stat, createReadStream, list };
}
