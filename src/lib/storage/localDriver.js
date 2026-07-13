import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const ROOT = path.resolve(process.env.STORAGE_LOCAL_PATH || "./storage");

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

  const start = range ? range.start : 0;
  const end = range ? Math.min(range.end, size - 1) : size - 1;

  const stream = fs.createReadStream(filePath, { start, end });
  return { stream, size, start, end };
}

export const localDriver = { write, read, exists, remove, stat, createReadStream };
