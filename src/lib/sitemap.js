import Sitemap, { SINGLETON_ID } from "../models/Sitemap.js";
import Page from "../models/Page.js";
import NavItem from "../models/NavItem.js";

// Hardcoded because the backend can't introspect Next's own route tree —
// must be kept in sync by hand with timeline/src/app/(public)/* whenever a
// new static public marketing page is added. CMS pages and nav links are
// discovered dynamically below instead.
const STATIC_PUBLIC_ROUTES = ["/", "/pricing", "/why-mytimelyne"];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Only an internal path belongs in the sitemap — NavItem.url is a free-form
// string with no schema-level internal/external distinction, so this is a
// runtime heuristic: excludes external links, protocol-relative urls,
// same-page anchors, and mailto:/tel: links.
function isInternalPath(url) {
  return (
    typeof url === "string" &&
    url.startsWith("/") &&
    !url.startsWith("//") &&
    !/^https?:\/\//i.test(url) &&
    !url.startsWith("#") &&
    !/^mailto:|^tel:/i.test(url)
  );
}

/** Returns null if a sitemap has never been generated — that's a distinct, real state (see routes/sitemap.js), not an auto-create-on-read singleton like most others. */
export async function getSitemap() {
  return Sitemap.findById(SINGLETON_ID);
}

export async function generateSitemap() {
  const [pages, navItems] = await Promise.all([
    Page.find({ status: "published" }).select("slug updatedAt").lean(),
    NavItem.find({ enabled: true }).select("url updatedAt children").lean(),
  ]);

  const now = new Date();
  // Keyed by path so overlapping entries (a nav link pointing at a CMS page
  // slug, say) naturally dedupe to a single <url>.
  const urls = new Map();
  for (const route of STATIC_PUBLIC_ROUTES) urls.set(route, now);
  for (const page of pages) urls.set(`/${page.slug}`, page.updatedAt || now);
  for (const item of navItems) {
    if (isInternalPath(item.url)) urls.set(item.url, item.updatedAt || now);
    for (const child of item.children || []) {
      if (child.enabled && isInternalPath(child.url)) urls.set(child.url, item.updatedAt || now);
    }
  }

  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const entries = [...urls.entries()]
    .map(
      ([path, lastmod]) =>
        `  <url>\n    <loc>${escapeXml(appUrl + path)}</loc>\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>\n  </url>`
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;

  return Sitemap.findByIdAndUpdate(
    SINGLETON_ID,
    { $set: { xml, urlCount: urls.size, generatedAt: now } },
    { upsert: true, new: true }
  );
}
