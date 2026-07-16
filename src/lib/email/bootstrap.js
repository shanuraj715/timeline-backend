import { EVENT_KEYS } from "./eventKeys.js";
import EmailTemplate from "../../models/EmailTemplate.js";
import { connectDB } from "../db/connect.js";

/**
 * Runs once at server startup (see server.js), mirroring
 * lib/storage/index.js's bootstrapDefaultProvider(). Ensures a row exists
 * for every EVENT_KEYS entry — create-if-missing only, so an admin's edits
 * to an already-existing template are never overwritten by a redeploy.
 */
export async function bootstrapEmailTemplates() {
  await connectDB();
  for (const seed of EVENT_KEYS) {
    const exists = await EmailTemplate.exists({ eventKey: seed.eventKey });
    if (exists) continue;
    await EmailTemplate.create({
      eventKey: seed.eventKey,
      name: seed.name,
      description: seed.description,
      subject: seed.subject,
      bodyHtml: seed.bodyHtml,
      isEnabled: true,
    });
  }
}
