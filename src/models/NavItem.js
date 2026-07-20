import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const ChildLinkSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true, trim: true, maxlength: 300 },
    order: { type: Number, default: 0 },
    openInNewTab: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
  },
  { _id: true }
);

const NavItemSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true, trim: true, maxlength: 300 },
    order: { type: Number, default: 0, index: true },
    openInNewTab: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    // Per-breakpoint visibility — all default true (shown everywhere),
    // matching this field's absence on every item that existed before it
    // was added. "Tablet" is the app's own md-to-lg range (see
    // timeline/src/styles/_variables.scss's $breakpoints); "mobile" is
    // below md, "desktop" is lg and up — same three-way split the public
    // header actually renders (see public-header.jsx/.module.scss).
    showOnMobile: { type: Boolean, default: true },
    showOnTablet: { type: Boolean, default: true },
    showOnDesktop: { type: Boolean, default: true },
    children: { type: [ChildLinkSchema], default: [] },
  },
  { timestamps: true }
);

export default models.NavItem || model("NavItem", NavItemSchema);
