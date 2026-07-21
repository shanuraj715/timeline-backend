import AnalyticsSettings, { SINGLETON_ID } from "../models/AnalyticsSettings.js";

export async function getAnalyticsSettings() {
  let settings = await AnalyticsSettings.findById(SINGLETON_ID);
  if (!settings) settings = await AnalyticsSettings.create({ _id: SINGLETON_ID });
  return settings;
}

export async function updateAnalyticsSettings(patch) {
  return AnalyticsSettings.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}
