// Pluggable storage adapter. Every driver implements the same interface:
//   write(key, buffer)              -> void
//   read(key)                       -> Buffer
//   stat(key)                       -> { size }
//   createReadStream(key, range?)   -> { stream, size, start, end }
//   remove(key)                     -> void
//   exists(key)                     -> boolean
//
// Keys are logical paths like "originals/{timelineId}/{YYYYMMDD}/{mediaId}.jpg"
// — never a full filesystem path or bucket URL — so swapping drivers never
// touches anything stored in Media documents.

import { localDriver } from "./localDriver.js";
import { s3Driver } from "./s3Driver.js";

function selectDriver() {
  const driver = process.env.STORAGE_DRIVER || "local";
  if (driver === "s3") return s3Driver;
  return localDriver;
}

export const storage = selectDriver();

export function buildStorageKey({ timelineId, dayKey, mediaId, extension, variant }) {
  const folder = variant === "thumbnail" ? "thumbnails" : variant === "preview" ? "previews" : "originals";
  return `${folder}/${timelineId}/${dayKey}/${mediaId}${extension}`;
}
