import EmailTemplate from "../../models/EmailTemplate.js";
import { connectDB } from "../db/connect.js";
import { getActiveEmailProvider } from "./index.js";
import { buildVariableContext } from "./context.js";
import { renderTemplate } from "./render.js";

/**
 * The single entry point every call site uses to send a system email.
 * Never throws — a broken/unconfigured provider must never break the
 * request that triggered it (registration, checkout, an invite, etc). Call
 * sites fire-and-forget: `sendTemplatedEmail(...).catch(() => {})` or just
 * don't await it if the response doesn't need to wait either way.
 *
 * `user` needs at least `name`/`email`/`credits` (a full Mongoose User doc
 * or a plain object with those fields both work — context.js only reads
 * plain properties). `vars` supplies event-specific variables the generic
 * user/site context doesn't cover (otp_code, plan_name, invite_url, etc).
 */
export async function sendTemplatedEmail(eventKey, { user, vars = {}, to } = {}) {
  const recipient = to || user?.email;
  if (!recipient) return { sent: false, reason: "no_recipient" };

  try {
    await connectDB();
    const template = await EmailTemplate.findOne({ eventKey });
    if (!template) return { sent: false, reason: "template_missing" };
    if (!template.isEnabled) return { sent: false, reason: "template_disabled" };

    const provider = await getActiveEmailProvider();
    if (!provider) return { sent: false, reason: "no_active_provider" };

    const context = buildVariableContext(user, vars);
    const subject = renderTemplate(template.subject, context);
    const html = renderTemplate(template.bodyHtml, context);

    await provider.send({ to: recipient, subject, html });
    return { sent: true };
  } catch (err) {
    console.error(`Failed to send "${eventKey}" email:`, err);
    return { sent: false, reason: "send_error", error: err.message };
  }
}
