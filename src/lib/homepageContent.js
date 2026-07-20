import HomepageContent, { SINGLETON_ID } from "../models/HomepageContent.js";

export async function getHomepageContent() {
  let content = await HomepageContent.findById(SINGLETON_ID);
  if (!content) content = await HomepageContent.create({ _id: SINGLETON_ID });
  return content;
}

export async function updateHomepageContent(patch) {
  return HomepageContent.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}
