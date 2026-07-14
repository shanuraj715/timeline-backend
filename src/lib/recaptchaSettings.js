import RecaptchaSettings, { SINGLETON_ID } from "../models/RecaptchaSettings.js";
import { decryptSecret } from "./crypto.js";

export async function getRecaptchaSettings() {
  let settings = await RecaptchaSettings.findById(SINGLETON_ID);
  if (!settings) settings = await RecaptchaSettings.create({ _id: SINGLETON_ID });
  return settings;
}

/** Decrypted secret key, or null if none is configured (never throws on a missing key). */
export async function getRecaptchaSecretKey() {
  const settings = await getRecaptchaSettings();
  if (!settings.secretKeyEncrypted) return null;
  return decryptSecret(settings.secretKeyEncrypted);
}

export async function updateRecaptchaSettings(patch) {
  return RecaptchaSettings.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}
