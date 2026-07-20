import WhyChooseUsContent, { SINGLETON_ID } from "../models/WhyChooseUsContent.js";

export async function getWhyChooseUsContent() {
  let content = await WhyChooseUsContent.findById(SINGLETON_ID);
  if (!content) content = await WhyChooseUsContent.create({ _id: SINGLETON_ID });
  return content;
}

export async function updateWhyChooseUsContent(patch) {
  return WhyChooseUsContent.findByIdAndUpdate(SINGLETON_ID, { $set: patch }, { upsert: true, new: true });
}
