import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Singleton — always read/written via getBrandingSettings()/updateBrandingSettings()
// in lib/brandingSettings.js, same fixed-_id pattern as PlatformSettings/HomepageContent.
const SINGLETON_ID = "branding";

const BrandingSettingsSchema = new Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    // Used both as the text-mode logo wordmark and the footer's copyright
    // line ("© {year} {siteName}. All rights reserved.").
    siteName: { type: String, trim: true, maxlength: 80, default: "Timeline" },
    logoMode: { type: String, enum: ["text", "image"], default: "text" },
    // Dark is only ever meaningful once Light is set (enforced in
    // lib/validation/branding.js) — Light is the fallback for both themes
    // when Dark is left empty.
    logoImageLight: { type: String, trim: true, maxlength: 500, default: "" },
    logoImageDark: { type: String, trim: true, maxlength: 500, default: "" },
    // px — only meaningful in image mode; the icon+text mode has its own
    // fixed size (logo.module.scss's .iconBadge), unaffected by this.
    logoImageHeight: { type: Number, min: 16, max: 120, default: 32 },
    footerTagline: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "A private, timeless home for your family's photos and videos.",
    },
    // Independent from the header's logoMode/logoImageLight/etc above — the
    // footer brand mark doesn't have to match the header's (same
    // Light-requires-Dark-fallback rule, enforced in lib/validation/branding.js).
    footerLogoMode: { type: String, enum: ["text", "image"], default: "text" },
    footerLogoImageLight: { type: String, trim: true, maxlength: 500, default: "" },
    footerLogoImageDark: { type: String, trim: true, maxlength: 500, default: "" },
    footerLogoImageHeight: { type: Number, min: 16, max: 120, default: 32 },
    // How the footer's brand column (logo + tagline) is aligned within its
    // own space — the footer's link columns are unaffected.
    footerAlign: { type: String, enum: ["left", "center", "right"], default: "left" },
  },
  { timestamps: true }
);

export { SINGLETON_ID };
export default models.BrandingSettings || model("BrandingSettings", BrandingSettingsSchema);
