import BrandingSettings, { SINGLETON_ID } from "../models/BrandingSettings.js";

export async function getBrandingSettings() {
  let settings = await BrandingSettings.findById(SINGLETON_ID);
  if (!settings) settings = await BrandingSettings.create({ _id: SINGLETON_ID });
  return settings;
}

export async function updateBrandingSettings(patch) {
  return BrandingSettings.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}
