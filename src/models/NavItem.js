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
    children: { type: [ChildLinkSchema], default: [] },
  },
  { timestamps: true }
);

export default models.NavItem || model("NavItem", NavItemSchema);
