import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Standard AdSense/IAB ad-unit sizes, plus a "responsive" auto-sizing
// option. Shared with lib/validation/ads.js (enum source) and mirrored into
// timeline-admin's own constants for the size <Select> — keep both lists in
// sync if this ever changes.
export const AD_SIZES = [
  "320x50",
  "320x100",
  "468x60",
  "300x250",
  "336x280",
  "728x90",
  "970x250",
  "160x600",
  "300x600",
  "responsive",
];

// Which page/page-group a placement belongs to — purely for grouping
// placements into tabs in the admin panel (see timeline-admin/src/pages/Ads.jsx),
// no effect on the frontend's own rendering. Mirrored (key + label) into
// that admin page's own GROUPS constant, same as AD_SIZES is mirrored.
export const AD_GROUPS = [
  { key: "homepage", label: "Homepage" },
  { key: "cms", label: "CMS pages" },
  { key: "timeline", label: "Timeline viewer" },
  { key: "dashboard", label: "Dashboard" },
  { key: "login", label: "Login page" },
  { key: "register", label: "Register page" },
];

// One sub-document per device tier (mobile/tablet/desktop) — independently
// enable/disable and size an ad for each, e.g. a placement can run a
// leaderboard on desktop, a smaller banner on mobile, and be switched off
// entirely on tablet. See components/shared/useAdBreakpoint.js on the
// frontend for how "current tier" is determined.
const DeviceConfigSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    size: { type: String, enum: AD_SIZES, default: "responsive" },
    // AdSense "ad slot" ID for this specific device's ad unit, e.g.
    // "1234567890". Left blank, this device tier never renders even if
    // `enabled` is true (see ad-slot.jsx).
    adSlotId: { type: String, trim: true, maxlength: 40, default: "" },
  },
  { _id: false }
);

// Fixed catalog of placements, seeded once at server startup (see
// lib/adPlacements.js's bootstrapAdPlacements, mirroring
// lib/email/bootstrap.js's bootstrapEmailTemplates) — `key` is the stable
// identifier every <AdSlot placement="..."> in the frontend references
// directly, so it's never editable from the admin panel (only label/
// description/enabled/devices are). See components/shared/ad-slot.jsx for
// the full list of keys and exactly where each one renders.
const AdPlacementSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    group: { type: String, required: true, enum: AD_GROUPS.map((g) => g.key) },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    // Admin-facing "where does this show" note — surfaced in the edit
    // modal so it's never ambiguous which page/spot a given placement is.
    description: { type: String, trim: true, maxlength: 300, default: "" },
    // Whole-placement toggle — the "separate toggle for all ad areas"
    // alongside AdSettings.adsEnabled's single master switch.
    enabled: { type: Boolean, default: true },
    devices: {
      mobile: { type: DeviceConfigSchema, default: () => ({}) },
      tablet: { type: DeviceConfigSchema, default: () => ({}) },
      desktop: { type: DeviceConfigSchema, default: () => ({}) },
    },
  },
  { timestamps: true }
);

export default models.AdPlacement || model("AdPlacement", AdPlacementSchema);
