// Kept in lockstep with timeline/src/app/api/cache/route.js's
// STATIC_WARMERS keys (same tag strings) — this is the admin panel's
// display catalog only; the frontend project separately maps these same
// tags to the actual fetcher functions, since only it can call Next's
// revalidateTag()/fetch cache directly. Published CMS pages are listed
// separately in routes/cache.js (queried live from the Page collection),
// not hardcoded here.
export const STATIC_CACHE_RESOURCES = [
  { tag: "nav", label: "Navigation" },
  { tag: "footer", label: "Footer" },
  { tag: "branding", label: "Branding" },
  { tag: "ads", label: "Ads settings" },
  { tag: "analytics", label: "Analytics settings" },
  { tag: "homepage", label: "Homepage" },
  { tag: "why-choose-us", label: "Why MyTimelyne page" },
  { tag: "pricing", label: "Pricing plans" },
  { tag: "feature-flags", label: "Feature flags" },
  { tag: "payment-gateways", label: "Payment gateways" },
];
