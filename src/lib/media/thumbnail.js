import sharp from "sharp";

const THUMBNAIL_EDGE = 480;
const PREVIEW_EDGE = 2000;

/**
 * Generates a grid thumbnail and a larger lightbox preview from an image
 * buffer, auto-rotating per EXIF orientation. Runs synchronously in the
 * upload request (Sharp is sub-second for this) so the client gets a ready
 * thumbnail immediately instead of a "processing" placeholder for the
 * overwhelming majority of uploads.
 */
export async function generateImageDerivatives(buffer) {
  const image = sharp(buffer, { failOn: "none" }).rotate();
  const metadata = await image.metadata();

  const [thumbnailBuffer, previewBuffer] = await Promise.all([
    image
      .clone()
      .resize({ width: THUMBNAIL_EDGE, height: THUMBNAIL_EDGE, fit: "cover" })
      .webp({ quality: 78 })
      .toBuffer(),
    image
      .clone()
      .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer(),
  ]);

  // metadata.width/height are pre-rotation for 90/270deg-rotated images;
  // swap them so stored dimensions match the auto-rotated output.
  const rotated = metadata.orientation && metadata.orientation >= 5;
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;

  return { width, height, thumbnailBuffer, previewBuffer };
}
