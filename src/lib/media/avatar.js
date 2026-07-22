import sharp from "sharp";

const AVATAR_EDGE = 512;

export class AvatarNotSquareError extends Error {
  constructor(width, height) {
    super(`Image must be square — got ${width}x${height}`);
    this.name = "AvatarNotSquareError";
    this.width = width;
    this.height = height;
  }
}

/**
 * Requires a square source image (the profile page's own file picker warns
 * before upload, but this is the actual enforcement) and resizes it down to
 * one fixed size for storage — an avatar is always rendered small, so
 * unlike media/thumbnail.js it doesn't need a separate thumbnail/preview
 * tier.
 */
export async function processAvatarImage(buffer) {
  const image = sharp(buffer, { failOn: "none" }).rotate();
  const metadata = await image.metadata();

  // metadata.width/height are pre-rotation for 90/270deg-rotated images;
  // swap them so the square check matches the auto-rotated output (same
  // reasoning as media/thumbnail.js's dimension swap).
  const rotated = metadata.orientation && metadata.orientation >= 5;
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;

  if (!width || !height || width !== height) {
    throw new AvatarNotSquareError(width || 0, height || 0);
  }

  const avatarBuffer = await image
    .resize({ width: AVATAR_EDGE, height: AVATAR_EDGE, fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();

  return { edge: AVATAR_EDGE, avatarBuffer };
}
