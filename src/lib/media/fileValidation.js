import { fileTypeFromBuffer } from "file-type";
import sanitizeHtml from "sanitize-html";

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

// SVG is XML text, not a binary format with magic bytes, so file-type (used
// for everything else below) never detects it — it has to be sniffed
// separately. Only the bounded prefix is inspected: the root element always
// appears near the top of a real SVG, and decoding a large binary upload as
// UTF-8 just to fail this check would be wasted work.
const SVG_SNIFF_BYTES = 4096;
const SVG_ROOT_PATTERN = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

function looksLikeSvg(buffer) {
  return SVG_ROOT_PATTERN.test(buffer.subarray(0, SVG_SNIFF_BYTES).toString("utf8"));
}

// Rejected outright rather than sanitized around — a DOCTYPE/ENTITY
// declaration has no legitimate purpose in an uploaded icon/illustration,
// and is exactly the mechanism behind XXE and entity-expansion ("billion
// laughs") attacks against any XML parser that might ever touch this file.
// sanitize-html's parser (htmlparser2) doesn't resolve external entities,
// but this closes the door regardless of parser internals, present or future.
const DANGEROUS_XML_PATTERN = /<!DOCTYPE|<!ENTITY/i;

// Deliberately an allowlist of the tags/attributes real vector icons and
// illustrations use, not a denylist of dangerous ones — <script>,
// <foreignObject>, and every `on*` event handler are excluded simply by
// never being listed, rather than needing to be individually blocked.
// <use>/href are left out entirely: their only legitimate purpose here
// (internal `#id` fragment refs for icon sprites) is a small enough loss to
// avoid the larger attack surface of validating href targets at all.
const SVG_ALLOWED_TAGS = [
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect",
  "text", "tspan", "defs", "clipPath", "linearGradient", "radialGradient", "stop",
  "mask", "pattern", "title", "desc", "marker",
];

const SVG_ALLOWED_ATTRIBUTES = {
  "*": [
    "id", "class", "style", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "opacity",
    "transform", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points",
    "width", "height", "viewBox", "preserveAspectRatio", "gradientUnits", "gradientTransform",
    "offset", "stop-color", "stop-opacity", "clip-path", "mask", "xmlns", "font-size",
    "font-family", "text-anchor",
    // Unit-space attributes for <mask>/<clipPath>/<pattern> — without these,
    // a <mask> with pixel-based x/y/width/height (the common case for
    // icon-style exports, e.g. from Figma) silently falls back to the
    // `objectBoundingBox` default, which puts the mask region wildly out of
    // alignment with the artwork and masks it out entirely rather than
    // producing a visibly wrong result — this is what made two real
    // uploaded brand logos (Google Drive, OneDrive) render as a blank chip.
    "maskUnits", "maskContentUnits", "clipPathUnits", "patternUnits", "patternContentUnits",
    "patternTransform",
  ],
};

/**
 * Strips <script>, event handlers, <foreignObject>, and anything else not
 * on the explicit allowlist above. Callers that accept SVG (see
 * validateMediaFile's `allowSvg` option) must write this sanitized buffer
 * to storage, never the original upload — validateMediaFile only classifies
 * the file, it doesn't transform it.
 */
export function sanitizeSvgBuffer(buffer) {
  const cleaned = sanitizeHtml(buffer.toString("utf8"), {
    allowedTags: SVG_ALLOWED_TAGS,
    allowedAttributes: SVG_ALLOWED_ATTRIBUTES,
    parser: { xmlMode: true },
  });
  return Buffer.from(cleaned, "utf8");
}

/**
 * `allowSvg` is opt-in per call site (see routes/cms.js, routes/themes.js,
 * routes/emailTemplates.js) — left off by default, and specifically off for
 * the main timeline media upload pipeline (routes/timelines.js), which is
 * open to every timeline member rather than admins only.
 */
export async function validateMediaFile(buffer, { allowSvg = false } = {}) {
  if (allowSvg && looksLikeSvg(buffer)) {
    if (DANGEROUS_XML_PATTERN.test(buffer.subarray(0, SVG_SNIFF_BYTES).toString("utf8"))) {
      return { valid: false, reason: "SVG files with a DOCTYPE or ENTITY declaration are not allowed" };
    }
    return { valid: true, type: "image", mime: "image/svg+xml", extension: ".svg" };
  }

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
