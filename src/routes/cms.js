import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import NavItem from "../models/NavItem.js";
import FooterColumn from "../models/FooterColumn.js";
import Page from "../models/Page.js";
import { navItemSchema, navItemReorderSchema, footerColumnSchema, footerColumnReorderSchema, createPageSchema, updatePageSchema } from "../lib/validation/cms.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requireSuperAdmin, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const cmsRouter = Router();
export const publicCmsRouter = Router();

// ---- Nav items (admin) ----

cmsRouter.get(
  "/nav",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;
    await connectDB();
    const pages = await Page.find({}).sort({ updatedAt: -1 });
    res.json({ pages });
  })
);

cmsRouter.get(
  "/pages/:id",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
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
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    await connectDB();
    const page = await Page.findByIdAndDelete(req.params.id);
    if (!page) return notFound(res, "Page not found");
    res.json({ ok: true });
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
