import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import Page from "../models/Page.js";
import { STATIC_CACHE_RESOURCES } from "../lib/cacheResources.js";
import { requirePermission } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { badRequest, serverError } from "../lib/apiError.js";

export const cacheRouter = Router();

const FRONTEND_URL = process.env.APP_URL || "http://localhost:3000";
const CACHE_SECRET = process.env.CACHE_REVALIDATE_SECRET || "";
// The frontend is a separate process (possibly mid-restart/redeploy) —
// this must not hang the admin panel request waiting on it forever.
const FETCH_TIMEOUT_MS = 10000;

// Only this route ever calls the frontend's /api/cache — everywhere else
// in this project, communication is the other direction (frontend calls
// this backend). Next's revalidateTag()/fetch cache can only be reached
// from code running inside the Next.js process itself, so the backend has
// no way to do this in-process the way it does for its own maintenance
// mode cache (lib/maintenance.js).
async function callFrontendCache(method, body) {
  if (!CACHE_SECRET) {
    throw new Error("CACHE_REVALIDATE_SECRET is not configured");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FRONTEND_URL}/api/cache`, {
      method,
      headers: { "Content-Type": "application/json", "X-Cache-Secret": CACHE_SECRET },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function listPublishedPageResources() {
  await connectDB();
  const pages = await Page.find({ status: "published" }, "title slug").lean();
  return pages.map((p) => ({ tag: `page:${p.slug}`, label: `Page: ${p.title}` }));
}

const EMPTY_STATUS = {
  lastGeneratedAt: null,
  purgedAt: null,
  hits: 0,
  misses: 0,
  lastElapsedMs: null,
  lastStatus: null,
  revalidateSeconds: null,
};

cacheRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.cache");
    if (!admin) return;

    const pageResources = await listPublishedPageResources();
    const catalog = [...STATIC_CACHE_RESOURCES, ...pageResources];

    let report;
    try {
      const { ok, data } = await callFrontendCache("GET");
      if (!ok) throw new Error("frontend returned an error");
      report = data?.tags || [];
    } catch (err) {
      return serverError(res, err, "Could not reach the frontend's cache report");
    }

    const byTag = new Map(report.map((t) => [t.tag, t]));
    const resources = catalog.map((r) => ({ ...r, ...(byTag.get(r.tag) || EMPTY_STATUS) }));

    res.json({ resources });
  })
);

cacheRouter.post(
  "/purge",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.cache");
    if (!admin) return;

    const tags = Array.isArray(req.body?.tags) ? req.body.tags : undefined;
    try {
      const { ok, data } = await callFrontendCache("POST", { action: "purge", tags });
      if (!ok) throw new Error("frontend returned an error");
      res.json({ ok: true, purged: data?.purged || [] });
    } catch (err) {
      serverError(res, err, "Could not purge cache");
    }
  })
);

cacheRouter.post(
  "/warm",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.cache");
    if (!admin) return;

    const tags = Array.isArray(req.body?.tags) ? req.body.tags : undefined;
    try {
      const { ok, data } = await callFrontendCache("POST", { action: "warm", tags });
      if (!ok) throw new Error("frontend returned an error");
      res.json({ ok: true, warmed: data?.warmed || [] });
    } catch (err) {
      serverError(res, err, "Could not warm cache");
    }
  })
);
