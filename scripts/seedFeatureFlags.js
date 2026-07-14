// Seeds the starter feature flags if they don't already exist. Safe to
// re-run — existing flags (and any admin edits to them) are left alone.
//
// Usage: npm run seed:flags

import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/lib/db/connect.js";
import FeatureFlag from "../src/models/FeatureFlag.js";
import { STARTER_FLAGS } from "../src/lib/featureFlags.js";

async function main() {
  await connectDB();

  for (const flag of STARTER_FLAGS) {
    const existing = await FeatureFlag.findOne({ key: flag.key });
    if (existing) {
      console.log(`Skipping existing flag: ${flag.key}`);
      continue;
    }
    await FeatureFlag.create({ ...flag, enabled: true });
    console.log(`Seeded flag: ${flag.key}`);
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
