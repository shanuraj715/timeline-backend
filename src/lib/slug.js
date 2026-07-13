import slugify from "slugify";
import { customAlphabet } from "nanoid";
import Timeline from "../models/Timeline.js";

const suffixId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 5);

export async function generateUniqueSlug(title) {
  const base = slugify(title, { lower: true, strict: true, trim: true }).slice(0, 80) || "timeline";

  let candidate = base;
  let attempt = 0;
  while (await Timeline.exists({ slug: candidate })) {
    attempt += 1;
    candidate = `${base}-${suffixId()}`;
    if (attempt > 10) throw new Error("Could not generate a unique slug");
  }
  return candidate;
}
