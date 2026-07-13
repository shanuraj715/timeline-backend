import { fileTypeFromBuffer } from "file-type";

// Never trust the client's declared Content-Type — sniff the real magic
// bytes and validate against an explicit allowlist.
const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
]);

const ALLOWED_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
]);

export async function validateMediaFile(buffer) {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) return { valid: false, reason: "Could not determine the file type" };

  if (ALLOWED_IMAGE_MIMES.has(detected.mime)) {
    return { valid: true, type: "image", mime: detected.mime, extension: `.${detected.ext}` };
  }
  if (ALLOWED_VIDEO_MIMES.has(detected.mime)) {
    return { valid: true, type: "video", mime: detected.mime, extension: `.${detected.ext}` };
  }

  return { valid: false, reason: `Unsupported file type: ${detected.mime}` };
}
