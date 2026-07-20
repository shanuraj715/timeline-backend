import AdPlacement from "../models/AdPlacement.js";
import { connectDB } from "./db/connect.js";

// Fixed catalog — one entry per <AdSlot placement="..."> call in the
// frontend. See timeline/src/components/shared/ad-slot.jsx for the
// authoritative "which key renders where" reference; keep the two in sync.
// `group` must be one of AdPlacement.js's AD_GROUPS keys — it's what the
// admin panel's Ads page groups placements into tabs by.
const PLACEMENT_SEEDS = [
  {
    key: "homepage_hero_bottom",
    group: "homepage",
    label: "Homepage — below hero",
    description: "app/(public)/page.jsx, right after the hero section",
    devices: {
      mobile: { enabled: true, size: "320x50" },
      tablet: { enabled: true, size: "468x60" },
      desktop: { enabled: true, size: "728x90" },
    },
  },
  {
    key: "homepage_before_cta",
    group: "homepage",
    label: "Homepage — before closing CTA",
    description: "app/(public)/page.jsx, right before the closing call-to-action",
    devices: {
      mobile: { enabled: true, size: "300x250" },
      tablet: { enabled: true, size: "300x250" },
      desktop: { enabled: true, size: "970x250" },
    },
  },
  {
    key: "cms_page_bottom",
    group: "cms",
    label: "CMS pages — after content",
    description: "app/(public)/[slug]/page.jsx, right after the article body",
    devices: {
      mobile: { enabled: true, size: "320x50" },
      tablet: { enabled: true, size: "468x60" },
      desktop: { enabled: true, size: "728x90" },
    },
  },
  {
    key: "cms_page_rail_left",
    group: "cms",
    label: "CMS pages — left rail",
    description: "app/(public)/[slug]/page.jsx, docked to the left edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "cms_page_rail_right",
    group: "cms",
    label: "CMS pages — right rail",
    description: "app/(public)/[slug]/page.jsx, docked to the right edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "timeline_page_bottom",
    group: "timeline",
    label: "Timeline viewer — bottom banner",
    description: "app/timeline/[slug]/page.jsx, docked to the bottom of the viewport",
    devices: {
      mobile: { enabled: true, size: "320x50" },
      tablet: { enabled: true, size: "468x60" },
      desktop: { enabled: true, size: "728x90" },
    },
  },
  {
    key: "timeline_page_left",
    group: "timeline",
    label: "Timeline viewer — left rail",
    description: "app/timeline/[slug]/page.jsx, docked to the left edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "timeline_page_right",
    group: "timeline",
    label: "Timeline viewer — right rail",
    description: "app/timeline/[slug]/page.jsx, docked to the right edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "dashboard_banner",
    group: "dashboard",
    label: "Dashboard — top banner",
    description: "app/(app)/layout.jsx, shown on every /dashboard/* page (main grid, billing, profile, settings, trash, manage-timeline)",
    devices: {
      mobile: { enabled: true, size: "320x50" },
      tablet: { enabled: true, size: "468x60" },
      desktop: { enabled: true, size: "728x90" },
    },
  },
  {
    key: "dashboard_rail_left",
    group: "dashboard",
    label: "Dashboard — left rail",
    description:
      "app/(app)/layout.jsx, docked to the left edge on every /dashboard/* page including manage-timeline (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "dashboard_rail_right",
    group: "dashboard",
    label: "Dashboard — right rail",
    description:
      "app/(app)/layout.jsx, docked to the right edge on every /dashboard/* page including manage-timeline (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "login_bottom",
    group: "login",
    label: "Login page — below card",
    description: "app/(auth)/login/page.jsx, below the sign-in card",
    devices: {
      mobile: { enabled: true, size: "320x50" },
      tablet: { enabled: true, size: "320x50" },
      desktop: { enabled: true, size: "468x60" },
    },
  },
  {
    key: "login_rail_left",
    group: "login",
    label: "Login page — left rail",
    description: "app/(auth)/login/page.jsx, docked to the left edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "login_rail_right",
    group: "login",
    label: "Login page — right rail",
    description: "app/(auth)/login/page.jsx, docked to the right edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "register_bottom",
    group: "register",
    label: "Register page — below card",
    description: "app/(auth)/register/page.jsx, below the sign-up card",
    devices: {
      mobile: { enabled: true, size: "320x50" },
      tablet: { enabled: true, size: "320x50" },
      desktop: { enabled: true, size: "468x60" },
    },
  },
  {
    key: "register_rail_left",
    group: "register",
    label: "Register page — left rail",
    description: "app/(auth)/register/page.jsx, docked to the left edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
  {
    key: "register_rail_right",
    group: "register",
    label: "Register page — right rail",
    description: "app/(auth)/register/page.jsx, docked to the right edge (desktop only by default)",
    devices: {
      mobile: { enabled: false, size: "responsive" },
      tablet: { enabled: false, size: "responsive" },
      desktop: { enabled: true, size: "160x600" },
    },
  },
];

/**
 * Runs once at server startup (see server.js), mirroring
 * lib/email/bootstrap.js's bootstrapEmailTemplates(). Create-if-missing
 * only, by `key` — an admin's edits to an already-existing placement (its
 * enabled/devices/label/description) are never overwritten by a redeploy.
 * `group` is the one exception: it's structural, not admin-customizable
 * data, so an existing placement seeded before `group` existed gets it
 * backfilled here rather than left blank forever.
 */
export async function bootstrapAdPlacements() {
  await connectDB();
  for (const seed of PLACEMENT_SEEDS) {
    const existing = await AdPlacement.findOne({ key: seed.key });
    if (existing) {
      if (existing.group !== seed.group) {
        await AdPlacement.updateOne({ key: seed.key }, { $set: { group: seed.group } });
      }
      continue;
    }
    await AdPlacement.create({ ...seed, enabled: true });
  }
}

export async function getAdPlacements() {
  return AdPlacement.find().sort({ key: 1 });
}

export async function getAdPlacementByKey(key) {
  return AdPlacement.findOne({ key });
}

// `key` is deliberately not accepted here — it's the stable identifier the
// frontend's <AdSlot> components reference and is never editable from the
// admin panel (see AdPlacement.js's schema comment).
export async function updateAdPlacement(key, patch) {
  return AdPlacement.findOneAndUpdate({ key }, { $set: patch }, { new: true });
}
