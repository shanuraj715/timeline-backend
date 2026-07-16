// Active-provider resolution, mirroring lib/storage/index.js's
// getStorage()/invalidateStorageCache() pattern exactly — except email has
// no bootstrap-a-default step and no "must always have one" invariant.
// Sending email is optional: no active provider is a normal, fully
// supported state (send.js just no-ops), unlike storage where every file
// write needs somewhere to go.
import { createSendgridDriver } from "./providers/sendgrid.js";
import { createSendpulseDriver } from "./providers/sendpulse.js";
import { createResendDriver } from "./providers/resend.js";
import { createSmtpDriver } from "./providers/smtp.js";
import { decryptSecret } from "../crypto.js";
import EmailProvider from "../../models/EmailProvider.js";
import { connectDB } from "../db/connect.js";

let cachedDriver = null;
let cachedProviderId = null;

export function invalidateEmailProviderCache() {
  cachedDriver = null;
  cachedProviderId = null;
}

function decryptCredentials(encrypted = {}) {
  return Object.fromEntries(Object.entries(encrypted).map(([k, v]) => [k, decryptSecret(v)]));
}

function buildDriver(providerDoc) {
  const creds = decryptCredentials(providerDoc.credentials);
  const config = providerDoc.config || {};
  const fromEmail = config.fromEmail || "";
  const fromName = config.fromName || "";

  switch (providerDoc.provider) {
    case "sendgrid":
      return createSendgridDriver({ apiKey: creds.apiKey, fromEmail, fromName });
    case "sendpulse":
      return createSendpulseDriver({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        fromEmail,
        fromName,
      });
    case "resend":
      return createResendDriver({ apiKey: creds.apiKey, fromEmail, fromName });
    case "smtp":
      return createSmtpDriver({
        host: config.host,
        port: config.port,
        secure: config.secure,
        username: creds.username,
        password: creds.password,
        fromEmail,
        fromName,
      });
    default:
      throw new Error(`Unknown email provider: ${providerDoc.provider}`);
  }
}

/** Returns the currently active+enabled provider's driver, or null if none is configured. */
export async function getActiveEmailProvider() {
  if (cachedProviderId) return cachedDriver;

  await connectDB();
  const active = await EmailProvider.findOne({ isDefault: true, isEnabled: true });
  if (!active) return null;

  cachedProviderId = active._id.toString();
  cachedDriver = buildDriver(active);
  return cachedDriver;
}
