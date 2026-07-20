import { Router } from "express";
import multer from "multer";
import { connectDB } from "../lib/db/connect.js";
import Theme from "../models/Theme.js";
import Timeline from "../models/Timeline.js";
import TimelineThemeOverride from "../models/TimelineThemeOverride.js";
import { createThemeSchema, updateThemeSchema } from "../lib/validation/themes.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateMediaFile, sanitizeSvgBuffer } from "../lib/media/fileValidation.js";
import { getStorage } from "../lib/storage/index.js";

export const themesRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function serializeTheme(theme) {
  return {
    id: theme._id.toString(),
    name: theme.name,
    slug: theme.slug,
    category: theme.category,
    description: theme.description,
    colors: theme.colors,
    imageUrl: theme.imageKey ? `/api/themes/${theme._id}/image` : null,
    imageUrlDark: theme.imageKeyDark ? `/api/themes/${theme._id}/image-dark` : null,
    imagePosition: theme.imagePosition,
    overlayStyle: theme.overlayStyle,
    overlayOpacity: theme.overlayOpacity,
    glassEffect: theme.glassEffect,
    glassBlur: theme.glassBlur,
    particleEffect: theme.particleEffect,
    particleCount: theme.particleCount,
    particleSpeed: theme.particleSpeed,
    particleMinSize: theme.particleMinSize,
    particleMaxSize: theme.particleMaxSize,
    particleInteractive: theme.particleInteractive,
    particleInteractionStrength: theme.particleInteractionStrength,
    nodeShape: theme.nodeShape,
    nodeBorderWidth: theme.nodeBorderWidth,
    nodeSize: theme.nodeSize,
    edgeStyle: theme.edgeStyle,
    priceCredits: theme.priceCredits,
    status: theme.status,
    isDefault: theme.isDefault,
    order: theme.order,
    createdAt: theme.createdAt,
    updatedAt: theme.updatedAt,
  };
}

themesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;
    await connectDB();
    const themes = await Theme.find({}).sort({ order: 1, createdAt: -1 });
    res.json({ themes: themes.map(serializeTheme) });
  })
);

themesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    const data = parseJson(req, res, createThemeSchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await Theme.findOne({ slug: data.slug });
      if (existing) return badRequest(res, "A theme with this slug already exists");

      const theme = await Theme.create(data);
      res.status(201).json({ theme: serializeTheme(theme) });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A theme with this slug already exists");
      serverError(res, err, "Failed to create theme");
    }
  })
);

themesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    const data = parseJson(req, res, updateThemeSchema);
    if (!data) return;

    try {
      await connectDB();
      if (data.slug) {
        const existing = await Theme.findOne({ slug: data.slug, _id: { $ne: req.params.id } });
        if (existing) return badRequest(res, "A theme with this slug already exists");
      }

      const theme = await Theme.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
      if (!theme) return notFound(res, "Theme not found");
      res.json({ theme: serializeTheme(theme) });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A theme with this slug already exists");
      serverError(res, err, "Failed to update theme");
    }
  })
);

themesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme) return notFound(res, "Theme not found");

    if (theme.isDefault) {
      return badRequest(res, "Can't delete the site default theme — set a different default first");
    }

    const [timelineCount, overrideCount] = await Promise.all([
      Timeline.countDocuments({ themeId: theme._id }),
      TimelineThemeOverride.countDocuments({ themeId: theme._id }),
    ]);
    if (timelineCount > 0 || overrideCount > 0) {
      return badRequest(res, "This theme is in use by one or more timelines and can't be deleted");
    }

    await theme.deleteOne();
    res.json({ ok: true });
  })
);

themesRouter.post(
  "/:id/set-default",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme) return notFound(res, "Theme not found");
    if (theme.status !== "published") return badRequest(res, "Only a published theme can be set as the site default");

    theme.isDefault = true;
    await theme.save();
    await Theme.updateMany({ _id: { $ne: theme._id } }, { $set: { isDefault: false } });

    res.json({ theme: serializeTheme(theme) });
  })
);

themesRouter.post(
  "/:id/image",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme) return notFound(res, "Theme not found");

    if (!req.file) return badRequest(res, "No image file was provided");

    const validation = await validateMediaFile(req.file.buffer, { allowSvg: true });
    if (!validation.valid || validation.type !== "image") {
      return badRequest(res, validation.reason || "File must be a valid image");
    }

    const fileBuffer = validation.mime === "image/svg+xml" ? sanitizeSvgBuffer(req.file.buffer) : req.file.buffer;

    const imageKey = `theme-assets/${theme._id}/image${validation.extension}`;
    const storage = await getStorage();
    await storage.write(imageKey, fileBuffer);

    theme.imageKey = imageKey;
    theme.imageMimeType = validation.mime;
    await theme.save();

    res.json({ theme: serializeTheme(theme) });
  })
);

themesRouter.delete(
  "/:id/image",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme) return notFound(res, "Theme not found");

    const storage = await getStorage();
    if (theme.imageKey) {
      await storage.remove(theme.imageKey).catch(() => {});
      theme.imageKey = null;
      theme.imageMimeType = null;
    }
    // Dark can never legitimately outlive Light (see imageKeyDark's comment
    // on the model) — removing Light removes Dark too, not just when Dark
    // was set moments ago but whenever it exists, so this invariant holds
    // after a delete the same way it's enforced on upload.
    if (theme.imageKeyDark) {
      await storage.remove(theme.imageKeyDark).catch(() => {});
      theme.imageKeyDark = null;
      theme.imageMimeTypeDark = null;
    }
    await theme.save();

    res.json({ theme: serializeTheme(theme) });
  })
);

themesRouter.post(
  "/:id/image-dark",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme) return notFound(res, "Theme not found");
    if (!theme.imageKey) return badRequest(res, "Upload a light theme image first");

    if (!req.file) return badRequest(res, "No image file was provided");

    const validation = await validateMediaFile(req.file.buffer, { allowSvg: true });
    if (!validation.valid || validation.type !== "image") {
      return badRequest(res, validation.reason || "File must be a valid image");
    }

    const fileBuffer = validation.mime === "image/svg+xml" ? sanitizeSvgBuffer(req.file.buffer) : req.file.buffer;

    const imageKeyDark = `theme-assets/${theme._id}/image-dark${validation.extension}`;
    const storage = await getStorage();
    await storage.write(imageKeyDark, fileBuffer);

    theme.imageKeyDark = imageKeyDark;
    theme.imageMimeTypeDark = validation.mime;
    await theme.save();

    res.json({ theme: serializeTheme(theme) });
  })
);

themesRouter.delete(
  "/:id/image-dark",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.themes");
    if (!admin) return;

    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme) return notFound(res, "Theme not found");

    if (theme.imageKeyDark) {
      const storage = await getStorage();
      await storage.remove(theme.imageKeyDark).catch(() => {});
      theme.imageKeyDark = null;
      theme.imageMimeTypeDark = null;
      await theme.save();
    }

    res.json({ theme: serializeTheme(theme) });
  })
);

// Public, unauthenticated by design — a theme's background image is
// decorative admin-uploaded artwork, not private user content, so it
// doesn't need the signed-token scheme media files use.
themesRouter.get(
  "/:id/image",
  asyncHandler(async (req, res) => {
    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme || !theme.imageKey) return notFound(res, "Image not found");
    const storage = await getStorage();
    if (!(await storage.exists(theme.imageKey))) return notFound(res, "Image not found in storage");

    try {
      const { stream, size } = await storage.createReadStream(theme.imageKey, null);
      res.writeHead(200, {
        "Content-Type": theme.imageMimeType || "application/octet-stream",
        "Cache-Control": "public, max-age=604800, immutable",
        "Content-Length": String(size),
        // See routes/cms.js's equivalent serve route for why: defense-in
        // -depth for a direct-navigation SVG open, on top of upload-time
        // sanitization.
        "Content-Security-Policy": "script-src 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      stream.pipe(res);
    } catch (err) {
      console.error("Failed to stream theme image:", err);
      notFound(res, "Image not found in storage");
    }
  })
);

// Public, unauthenticated — mirrors GET /:id/image exactly, just for the
// optional dark-mode variant.
themesRouter.get(
  "/:id/image-dark",
  asyncHandler(async (req, res) => {
    await connectDB();
    const theme = await Theme.findById(req.params.id);
    if (!theme || !theme.imageKeyDark) return notFound(res, "Image not found");
    const storage = await getStorage();
    if (!(await storage.exists(theme.imageKeyDark))) return notFound(res, "Image not found in storage");

    try {
      const { stream, size } = await storage.createReadStream(theme.imageKeyDark, null);
      res.writeHead(200, {
        "Content-Type": theme.imageMimeTypeDark || "application/octet-stream",
        "Cache-Control": "public, max-age=604800, immutable",
        "Content-Length": String(size),
        "Content-Security-Policy": "script-src 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      stream.pipe(res);
    } catch (err) {
      console.error("Failed to stream theme dark image:", err);
      notFound(res, "Image not found in storage");
    }
  })
);
