import exifr from "exifr";

/**
 * Pulls the capture date and GPS coordinates directly out of the file's own
 * EXIF/metadata. This is core to the whole premise of a chronological
 * archive: scanned photos, old phone exports, and bulk imports routinely
 * have an upload date that's years apart from when the memory actually
 * happened, so EXIF (not upload time) must be the primary source of truth.
 */
export async function extractImageExif(buffer) {
  try {
    const data = await exifr.parse(buffer, {
      pick: [
        "DateTimeOriginal",
        "CreateDate",
        "ModifyDate",
        "GPSLatitude",
        "GPSLongitude",
        "Make",
        "Model",
        "LensModel",
        "ISO",
        "FNumber",
        "ExposureTime",
        "FocalLength",
      ],
      gps: true,
    });

    if (!data) return { captureDate: null, gps: null, camera: null };

    const captureDate = data.DateTimeOriginal || data.CreateDate || data.ModifyDate || null;
    const gps =
      typeof data.latitude === "number" && typeof data.longitude === "number"
        ? { lat: data.latitude, lng: data.longitude }
        : null;

    const camera =
      data.Make || data.Model || data.LensModel || data.ISO || data.FNumber || data.ExposureTime || data.FocalLength
        ? {
            make: data.Make || null,
            model: data.Model || null,
            lens: data.LensModel || null,
            iso: typeof data.ISO === "number" ? data.ISO : null,
            fNumber: typeof data.FNumber === "number" ? data.FNumber : null,
            exposureTime: typeof data.ExposureTime === "number" ? data.ExposureTime : null,
            focalLength: typeof data.FocalLength === "number" ? data.FocalLength : null,
          }
        : null;

    return { captureDate: captureDate ? new Date(captureDate) : null, gps, camera };
  } catch {
    // Corrupt/absent EXIF is expected for plenty of files — never fail the upload over it.
    return { captureDate: null, gps: null, camera: null };
  }
}
