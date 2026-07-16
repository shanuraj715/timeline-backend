import GoogleOAuthSettings, { SINGLETON_ID } from "../models/GoogleOAuthSettings.js";
import { decryptSecret } from "./crypto.js";

export async function getGoogleOAuthSettings() {
  let settings = await GoogleOAuthSettings.findById(SINGLETON_ID);
  if (!settings) settings = await GoogleOAuthSettings.create({ _id: SINGLETON_ID });
  return settings;
}

export async function updateGoogleOAuthSettings(patch) {
  return GoogleOAuthSettings.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}

/**
 * Resolved, ready-to-use client credentials, or null if Google sign-in
 * isn't fully configured+enabled — the single check every call site
 * (the /google and /google/callback routes, the public config route)
 * shares, so "enabled" always means the exact same thing everywhere.
 */
export async function getActiveGoogleOAuthClient() {
  const settings = await getGoogleOAuthSettings();
  if (!settings.isEnabled || !settings.clientId || !settings.clientSecretEncrypted) return null;
  return { clientId: settings.clientId, clientSecret: decryptSecret(settings.clientSecretEncrypted) };
}
