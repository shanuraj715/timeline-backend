import { Router } from "express";
import multer from "multer";
import { customAlphabet } from "nanoid";
import { connectDB } from "../lib/db/connect.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { EVENT_KEY_VALUES } from "../lib/email/eventKeys.js";
import { buildVariableContext } from "../lib/email/context.js";
import { renderTemplate } from "../lib/email/render.js";
import { getActiveEmailProvider } from "../lib/email/index.js";
import { updateEmailTemplateSchema, testEmailTemplateSchema } from "../lib/validation/email.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requireSuperAdmin, notFound } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateMediaFile } from "../lib/media/fileValidation.js";
import { getStorage } from "../lib/storage/index.js";

export const emailTemplatesRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const imageId = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 20);
const IMAGE_EXT_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Sample data so preview/test always renders something meaningful — none of
// this is stored, it only exists to fill in the event-specific variables a
// real send would supply (an OTP code, a purchased plan name, an invite
// link, etc). The generic user variables (fname/email/total_credit/...) use
// the *actual* requesting admin's own account instead, so a test send feels
// like real mail rather than entirely synthetic.
const SAMPLE_VARS = {
  welcome: { signup_bonus_credits: "50" },
  password_reset_otp: { otp_code: "482913", otp_expiry_minutes: "10" },
  purchase_complete: {
    plan_name: "Pro Plan",
    credits_purchased: "500",
    amount_paid: "499.00",
    currency: "INR",
    order_id: "SAMPLE-ORDER-123",
  },
  credits_added: { credits_amount: "100", credit_reason: "Support goodwill credit" },
  invitation: {
    inviter_name: "Jordan Lee",
    timeline_title: "Family Memories",
    invite_role: "editor",
    invite_url: `${process.env.APP_URL || ""}/invite/sample-token`,
    invite_expiry_days: "7",
  },
  account_locked: { lock_duration: "15 minutes" },
};

function serialize(template) {
  return {
    eventKey: template.eventKey,
    name: template.name,
    description: template.description,
    subject: template.subject,
    bodyHtml: template.bodyHtml,
    isEnabled: template.isEnabled,
    updatedAt: template.updatedAt,
  };
}

emailTemplatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;
    await connectDB();
    const templates = await EmailTemplate.find({}).sort({ eventKey: 1 });
    res.json({ templates: templates.map(serialize) });
  })
);

emailTemplatesRouter.patch(
  "/:eventKey",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    if (!EVENT_KEY_VALUES.includes(req.params.eventKey)) return badRequest(res, "Unknown email event");

    const data = parseJson(req, res, updateEmailTemplateSchema);
    if (!data) return;

    await connectDB();
    const template = await EmailTemplate.findOneAndUpdate(
      { eventKey: req.params.eventKey },
      { $set: data },
      { new: true }
    );
    if (!template) return notFound(res, "Template not found");
    res.json({ template: serialize(template) });
  })
);

emailTemplatesRouter.post(
  "/:eventKey/preview",
  asyncHandler(async (req, res) => {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    if (!EVENT_KEY_VALUES.includes(req.params.eventKey)) return badRequest(res, "Unknown email event");

    await connectDB();
    const template = await EmailTemplate.findOne({ eventKey: req.params.eventKey });
    if (!template) return notFound(res, "Template not found");

    // Optional subject/bodyHtml in the request body previews an unsaved
    // draft (what the admin is currently typing in the editor) instead of
    // whatever's already saved — otherwise "live preview" would only ever
    // reflect the last save, not the edits actually being previewed.
    const subject = typeof req.body?.subject === "string" ? req.body.subject : template.subject;
    const bodyHtml = typeof req.body?.bodyHtml === "string" ? req.body.bodyHtml : template.bodyHtml;

    const context = buildVariableContext(admin, SAMPLE_VARS[req.params.eventKey] || {});
    res.json({
      subject: renderTemplate(subject, context),
      html: renderTemplate(bodyHtml, context),
    });
  })
);

emailTemplatesRouter.post(
  "/:eventKey/test",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    if (!EVENT_KEY_VALUES.includes(req.params.eventKey)) return badRequest(res, "Unknown email event");

    const data = parseJson(req, res, testEmailTemplateSchema);
    if (!data) return;

    await connectDB();
    const template = await EmailTemplate.findOne({ eventKey: req.params.eventKey });
    if (!template) return notFound(res, "Template not found");

    const provider = await getActiveEmailProvider();
    if (!provider) return badRequest(res, "No active, enabled email provider is configured");

    try {
      const context = buildVariableContext(admin, SAMPLE_VARS[req.params.eventKey] || {});
      const subject = renderTemplate(template.subject, context);
      const html = renderTemplate(template.bodyHtml, context);
      await provider.send({ to: data.to || admin.email, subject, html });
      res.json({ ok: true, sentTo: data.to || admin.email });
    } catch (err) {
      serverError(res, err, "Failed to send test email");
    }
  })
);

// Images the visual editor embeds directly in bodyHtml as <img src="...">
// — there's no EmailTemplate field pointing at these (unlike a theme's
// single imageKey), the reference lives entirely in the HTML content
// itself, so no DB row is needed per image: the filename returned here
// (id + extension) IS the storage key, and the extension alone is enough
// to serve the right Content-Type back. Returns an absolute URL rooted at
// APP_URL (not this backend's own possibly-internal-only origin, and not
// the admin panel's origin, which isn't meant to be publicly reachable) —
// a relative src would be broken the moment the HTML leaves the admin
// panel's preview and is read as an actual email.
emailTemplatesRouter.post(
  "/images",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;

    if (!req.file) return badRequest(res, "No image file was provided");

    const validation = await validateMediaFile(req.file.buffer);
    if (!validation.valid || validation.type !== "image") {
      return badRequest(res, validation.reason || "File must be a valid image");
    }

    const filename = `${imageId()}${validation.extension}`;
    const storage = await getStorage();
    await storage.write(`email-assets/${filename}`, req.file.buffer);

    res.status(201).json({ url: `${process.env.APP_URL || ""}/api/email-templates/images/${filename}` });
  })
);

// Public, unauthenticated by design — same reasoning as themes.js's image
// route: decorative admin-authored artwork, and email clients fetching it
// have no session/cookie to present anyway.
emailTemplatesRouter.get(
  "/images/:filename",
  asyncHandler(async (req, res) => {
    const { filename } = req.params;
    if (!/^[A-Za-z0-9]+\.(jpg|jpeg|png|gif|webp)$/.test(filename)) return notFound(res, "Image not found");

    const storage = await getStorage();
    const key = `email-assets/${filename}`;
    if (!(await storage.exists(key))) return notFound(res, "Image not found in storage");

    const ext = filename.slice(filename.lastIndexOf("."));
    try {
      const { stream, size } = await storage.createReadStream(key, null);
      res.writeHead(200, {
        "Content-Type": IMAGE_EXT_MIME[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=604800, immutable",
        "Content-Length": String(size),
      });
      stream.pipe(res);
    } catch (err) {
      console.error("Failed to stream email template image:", err);
      notFound(res, "Image not found in storage");
    }
  })
);
