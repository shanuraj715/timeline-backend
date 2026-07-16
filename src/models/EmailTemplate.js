import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// One document per EVENT_KEY (see lib/email/eventKeys.js) — a fixed,
// code-defined set, not an admin-creatable list. Every key must correspond
// to a real code path that actually calls sendTemplatedEmail(eventKey, ...),
// so there's deliberately no create/delete route for these, only edit —
// bootstrapEmailTemplates() (lib/email/bootstrap.js) seeds one row per key
// at server startup.
const EmailTemplateSchema = new Schema(
  {
    eventKey: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    subject: { type: String, required: true },
    bodyHtml: { type: String, required: true },
    isEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default models.EmailTemplate || model("EmailTemplate", EmailTemplateSchema);
