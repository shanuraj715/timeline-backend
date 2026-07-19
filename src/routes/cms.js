import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import { connectDB } from "../lib/db/connect.js";
import NavItem from "../models/NavItem.js";
import FooterColumn from "../models/FooterColumn.js";
import Page from "../models/Page.js";
import { navItemSchema, navItemReorderSchema, footerColumnSchema, footerColumnReorderSchema, createPageSchema, updatePageSchema } from "../lib/validation/cms.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateMediaFile } from "../lib/media/fileValidation.js";
import { getStorage } from "../lib/storage/index.js";
import CmsMedia from "../models/CmsMedia.js";

export const cmsRouter = Router();
export const publicCmsRouter = Router();

const uploadCmsMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Flat namespace ("cms-media/<uuid><ext>") rather than page-scoped, since an
// image/video is embedded inline in a page's rich-text `content` and isn't
// tied to a single field the way a theme's one background image is — the
// admin can insert one before the page itself has even been saved. There's
// no DB record tracking these (unlike Theme.imageKey), so removing an image
// from a page's content doesn't delete the underlying file — an accepted
// gap, not a leak: storage isn't public-listable and orphaned files cost
// nothing but disk space.
function cmsMediaKey(filename) {
  return `cms-media/${filename}`;
}

// No DB record tracks each upload's mime type (see cmsMediaKey's comment),
// so the read route re-derives Content-Type from the extension baked into
// the filename at upload time — mirrors validateMediaFile's own allowlist.
const EXTENSION_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

function mimeForFilename(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return EXTENSION_MIME[ext] || "application/octet-stream";
}

// ---- Nav items (admin) ----

cmsRouter.get(
  "/nav",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "content.navigation");
    if (!admin) return;
    await connectDB();
    const items = await NavItem.find({}).sort({ order: 1 });
    res.json({ items });
  })
);

cmsRouter.post(
  "/nav",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.navigation");
    if (!admin) return;

    const data = parseJson(req, res, navItemSchema);
    if (!data) return;

    try {
      await connectDB();
      const item = await NavItem.create(data);
      res.status(201).json({ item });
    } catch (err) {
      serverError(res, err, "Failed to create nav item");
    }
  })
);

cmsRouter.patch(
  "/nav/reorder",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.navigation");
    if (!admin) return;

    const data = parseJson(req, res, navItemReorderSchema);
    if (!data) return;

    await connectDB();
    await Promise.all(data.items.map((i) => NavItem.updateOne({ _id: i.id }, { $set: { order: i.order } })));
    res.json({ ok: true });
  })
);

cmsRouter.patch(
  "/nav/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.navigation");
    if (!admin) return;

    const data = parseJson(req, res, navItemSchema.partial());
    if (!data) return;

    await connectDB();
    const item = await NavItem.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
    if (!item) return notFound(res, "Nav item not found");
    res.json({ item });
  })
);

cmsRouter.delete(
  "/nav/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.navigation");
    if (!admin) return;

    await connectDB();
    const item = await NavItem.findByIdAndDelete(req.params.id);
    if (!item) return notFound(res, "Nav item not found");
    res.json({ ok: true });
  })
);

// ---- Footer columns (admin) ----

cmsRouter.get(
  "/footer",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "content.footer");
    if (!admin) return;
    await connectDB();
    const columns = await FooterColumn.find({}).sort({ order: 1 });
    res.json({ columns });
  })
);

cmsRouter.post(
  "/footer",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.footer");
    if (!admin) return;

    const data = parseJson(req, res, footerColumnSchema);
    if (!data) return;

    try {
      await connectDB();
      const column = await FooterColumn.create(data);
      res.status(201).json({ column });
    } catch (err) {
      serverError(res, err, "Failed to create footer column");
    }
  })
);

cmsRouter.patch(
  "/footer/reorder",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.footer");
    if (!admin) return;

    const data = parseJson(req, res, footerColumnReorderSchema);
    if (!data) return;

    await connectDB();
    await Promise.all(data.items.map((i) => FooterColumn.updateOne({ _id: i.id }, { $set: { order: i.order } })));
    res.json({ ok: true });
  })
);

cmsRouter.patch(
  "/footer/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.footer");
    if (!admin) return;

    const data = parseJson(req, res, footerColumnSchema.partial());
    if (!data) return;

    await connectDB();
    const column = await FooterColumn.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
    if (!column) return notFound(res, "Footer column not found");
    res.json({ column });
  })
);

cmsRouter.delete(
  "/footer/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.footer");
    if (!admin) return;

    await connectDB();
    const column = await FooterColumn.findByIdAndDelete(req.params.id);
    if (!column) return notFound(res, "Footer column not found");
    res.json({ ok: true });
  })
);

// ---- Pages / CMS (admin) ----

cmsRouter.get(
  "/pages",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "content.pages");
    if (!admin) return;
    await connectDB();
    const pages = await Page.find({}).sort({ updatedAt: -1 });
    res.json({ pages });
  })
);

cmsRouter.get(
  "/pages/:id",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "content.pages");
    if (!admin) return;
    await connectDB();
    const page = await Page.findById(req.params.id);
    if (!page) return notFound(res, "Page not found");
    res.json({ page });
  })
);

cmsRouter.post(
  "/pages",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.pages");
    if (!admin) return;

    const data = parseJson(req, res, createPageSchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await Page.findOne({ slug: data.slug });
      if (existing) return badRequest(res, "A page with this slug already exists");

      const page = await Page.create({
        ...data,
        publishedAt: data.status === "published" ? new Date() : null,
      });
      res.status(201).json({ page });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A page with this slug already exists");
      serverError(res, err, "Failed to create page");
    }
  })
);

cmsRouter.patch(
  "/pages/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.pages");
    if (!admin) return;

    const data = parseJson(req, res, updatePageSchema);
    if (!data) return;

    try {
      await connectDB();
      const page = await Page.findById(req.params.id);
      if (!page) return notFound(res, "Page not found");

      if (data.slug && data.slug !== page.slug) {
        const existing = await Page.findOne({ slug: data.slug, _id: { $ne: page._id } });
        if (existing) return badRequest(res, "A page with this slug already exists");
      }

      const wasPublished = page.status === "published";
      Object.assign(page, data);
      if (data.status === "published" && !wasPublished) page.publishedAt = new Date();
      await page.save();

      res.json({ page });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "A page with this slug already exists");
      serverError(res, err, "Failed to update page");
    }
  })
);

cmsRouter.delete(
  "/pages/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.pages");
    if (!admin) return;

    await connectDB();
    const page = await Page.findByIdAndDelete(req.params.id);
    if (!page) return notFound(res, "Page not found");
    res.json({ ok: true });
  })
);

// ---- Page content media (image/video uploads for the rich-text editor) ----

cmsRouter.post(
  "/media",
  uploadCmsMedia.single("file"),
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.pages");
    if (!admin) return;

    if (!req.file) return badRequest(res, "No file was provided");

    const validation = await validateMediaFile(req.file.buffer);
    if (!validation.valid) return badRequest(res, validation.reason || "Unsupported file type");

    const filename = `${crypto.randomUUID()}${validation.extension}`;
    const key = cmsMediaKey(filename);
    const storage = await getStorage();
    await storage.write(key, req.file.buffer);

    await connectDB();
    await CmsMedia.create({
      key,
      filename,
      mime: validation.mime,
      type: validation.type,
      size: req.file.buffer.length,
      uploadedByUserId: admin._id,
    });

    res.status(201).json({
      url: `/api/cms/media/${filename}`,
      type: validation.type,
      mime: validation.mime,
    });
  })
);

// Public, unauthenticated by design — same reasoning as themes' background
// image route: admin-authored page content, not private user media, so it
// doesn't need the signed-token scheme timeline media files use.
cmsRouter.get(
  "/media/:filename",
  asyncHandler(async (req, res) => {
    // Filenames are always crypto.randomUUID() + a known extension (see the
    // upload route) — rejecting anything else closes off path traversal via
    // this param without needing to sanitize/resolve paths ourselves.
    if (!/^[0-9a-f-]+\.[a-z0-9]+$/i.test(req.params.filename)) return notFound(res, "File not found");

    const key = cmsMediaKey(req.params.filename);
    const storage = await getStorage();
    if (!(await storage.exists(key))) return notFound(res, "File not found");

    try {
      const { stream, size } = await storage.createReadStream(key, null);
      res.writeHead(200, {
        "Content-Type": mimeForFilename(req.params.filename),
        "Cache-Control": "public, max-age=604800, immutable",
        "Content-Length": String(size),
      });
      stream.pipe(res);
    } catch (err) {
      console.error("Failed to stream cms media:", err);
      notFound(res, "File not found in storage");
    }
  })
);

// ---- Public (unauthenticated) ----

publicCmsRouter.get(
  "/nav",
  asyncHandler(async (req, res) => {
    await connectDB();
    const items = await NavItem.find({ enabled: true }).sort({ order: 1 });
    res.json({
      items: items.map((i) => ({
        id: i._id.toString(),
        label: i.label,
        url: i.url,
        openInNewTab: i.openInNewTab,
        children: i.children
          .filter((c) => c.enabled)
          .sort((a, b) => a.order - b.order)
          .map((c) => ({ id: c._id.toString(), label: c.label, url: c.url, openInNewTab: c.openInNewTab })),
      })),
    });
  })
);

publicCmsRouter.get(
  "/footer",
  asyncHandler(async (req, res) => {
    await connectDB();
    const columns = await FooterColumn.find({ enabled: true }).sort({ order: 1 });
    res.json({
      columns: columns.map((c) => ({
        id: c._id.toString(),
        title: c.title,
        contentType: c.contentType,
        html: c.html,
        links: c.links
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((l) => ({ id: l._id.toString(), label: l.label, url: l.url, openInNewTab: l.openInNewTab })),
      })),
    });
  })
);

publicCmsRouter.get(
  "/pages/:slug",
  asyncHandler(async (req, res) => {
    await connectDB();
    const page = await Page.findOne({ slug: req.params.slug, status: "published" });
    if (!page) return notFound(res, "Page not found");
    res.json({
      page: {
        title: page.title,
        slug: page.slug,
        content: page.content,
        showTitle: page.showTitle,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
        publishedAt: page.publishedAt,
      },
    });
  })
);
