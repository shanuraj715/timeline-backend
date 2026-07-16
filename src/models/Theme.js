import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const ThemeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    category: { type: String, trim: true, maxlength: 60, default: "" },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    colors: {
      primary: { type: String, default: "#0a84ff" },
      secondary: { type: String, default: "#6e6e73" },
      // Optional overrides for the timeline's node/edge/date-chip styling —
      // "" means "use the app's default styling" rather than this theme's
      // own color. Kept separate from primary/secondary (which drive the
      // page-level background wash) since a theme designer may want the
      // wash colors without changing the timeline's own line/dot chrome.
      node: { type: String, default: "" },
      edge: { type: String, default: "" },
      dateChipBackground: { type: String, default: "" },
      dateChipText: { type: String, default: "" },
      // "" means "match the page background", same as the pre-existing
      // node/edge/chip fields — that's what produces the halo/cutout look
      // against the timeline wash rather than a fixed color.
      nodeBorder: { type: String, default: "" },
    },
    nodeShape: {
      type: String,
      enum: ["circle", "square", "triangle", "heart", "diamond", "star", "pentagon", "hexagon"],
      default: "circle",
    },
    // px. 0 = no visible border ring around the node.
    nodeBorderWidth: { type: Number, min: 0, max: 12, default: 4 },
    // px, the node/dot's own width+height (day-node.module.scss's old
    // hardcoded 8px).
    nodeSize: { type: Number, min: 4, max: 24, default: 8 },
    // The connector line between nodes. "line" (thin solid, the original
    // look), "ribbon" (thicker solid), "dashed", "dotted".
    edgeStyle: { type: String, enum: ["line", "ribbon", "dashed", "dotted"], default: "line" },
    // Storage key (via lib/storage) for the uploaded background/preview
    // image — same abstraction Media already uses, not a separate asset
    // pipeline.
    imageKey: { type: String, default: null },
    imageMimeType: { type: String, default: null },
    imagePosition: { type: String, enum: ["center", "top", "bottom"], default: "center" },
    // How the background wash's color layer combines with the image:
    // "gradient" (primary->secondary diagonal, the default), "solid" (flat
    // primary tint), or "none" (raw image only, no color layer).
    overlayStyle: { type: String, enum: ["gradient", "solid", "none"], default: "gradient" },
    overlayOpacity: { type: Number, min: 0, max: 100, default: 60 },
    // Blurs the background image into a soft frosted backdrop instead of a
    // sharp photo — off by default so existing themes render unchanged.
    // glassBlur only takes effect while glassEffect is on.
    glassEffect: { type: Boolean, default: false },
    glassBlur: { type: Number, min: 0, max: 40, default: 20 },
    // Ambient floating/falling glyphs over the whole page (CSS-animated,
    // not literal 3D/WebGL — see components/timeline/particle-field.jsx).
    // "none" is the default; off costs nothing extra to render.
    particleEffect: {
      type: String,
      enum: ["none", "sparkles", "leaves", "hearts", "confetti", "gifts", "snow"],
      default: "none",
    },
    particleCount: { type: Number, min: 5, max: 60, default: 24 },
    // Multiplier on the base fall speed — 1 = default speed, 3 = 3x faster,
    // 0.5 = half speed.
    particleSpeed: { type: Number, min: 0.5, max: 3, default: 1 },
    // px. Each particle's own size is randomized between these two bounds
    // (nearer/"depth" particles lean toward the max, farther toward the
    // min), rather than a single fixed size — see particle-field.jsx.
    particleMinSize: { type: Number, min: 4, max: 60, default: 14 },
    particleMaxSize: { type: Number, min: 4, max: 80, default: 34 },
    // When on, particles are gently pushed away from the cursor/touch point
    // (a repulsion force, not a hitbox) instead of ignoring input entirely.
    particleInteractive: { type: Boolean, default: false },
    // Multiplier on both the pointer's influence radius and push strength —
    // 1 = default, 3 = a much wider/stronger scatter, 0.5 = a subtle nudge.
    // Only meaningful while particleInteractive is on.
    particleInteractionStrength: { type: Number, min: 0.5, max: 3, default: 1 },
    // 0 = free/unlocked for every timeline with no purchase needed.
    priceCredits: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    isDefault: { type: Boolean, default: false, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default models.Theme || model("Theme", ThemeSchema);
