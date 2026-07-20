import AdSettings, { SINGLETON_ID } from "../models/AdSettings.js";

export async function getAdSettings() {
  let settings = await AdSettings.findById(SINGLETON_ID);
  if (!settings) settings = await AdSettings.create({ _id: SINGLETON_ID });
  return settings;
}

export async function updateAdSettings(patch) {
  return AdSettings.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}
