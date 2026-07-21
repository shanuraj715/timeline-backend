import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import { getSitemap, generateSitemap } from "../lib/sitemap.js";
import { badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logSecurityEvent } from "../lib/logger.js";

export const sitemapRouter = Router();
export const publicSitemapRouter = Router();

function serialize(doc) {
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return {
    generatedAt: doc?.generatedAt || null,
    urlCount: doc?.urlCount || 0,
    publicUrl: `${appUrl}/sitemap.xml`,
  };
}

// Metadata only (not the raw XML) — keeps this payload small; the actual
// XML is served from the public route below.
sitemapRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "content.sitemap");
    if (!admin) return;

    await connectDB();
    const doc = await getSitemap();
    res.json(serialize(doc));
  })
);

sitemapRouter.post(
  "/generate",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "content.sitemap");
    if (!admin) return;

    try {
      await connectDB();
      const doc = await generateSitemap();

      await logSecurityEvent({
        userId: admin._id,
        action: "admin_generated_sitemap",
        ip: clientIp(req),
        metadata: { urlCount: doc.urlCount },
      });

      res.json(serialize(doc));
    } catch (err) {
      serverError(res, err, "Failed to generate sitemap");
    }
  })
);

// Public: raw XML, not JSON — this is what timeline/src/app/sitemap.xml/
// route.js fetches and passes through to visitors/crawlers.
publicSitemapRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const doc = await getSitemap();
    if (!doc) {
      res.status(404).json({ error: "Sitemap has not been generated yet", code: "NOT_FOUND" });
      return;
    }
    res.type("application/xml").send(doc.xml);
  })
);
