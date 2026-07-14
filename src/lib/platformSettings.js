import PlatformSettings, { SINGLETON_ID } from "../models/PlatformSettings.js";

export async function getPlatformSettings() {
  let settings = await PlatformSettings.findById(SINGLETON_ID);
  if (!settings) settings = await PlatformSettings.create({ _id: SINGLETON_ID });
  return settings;
}

export async function updatePlatformSettings(patch) {
  return PlatformSettings.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}
