// Promotes the account matching SUPERADMIN_EMAIL to the platform superadmin
// role. New registrations using that email are promoted automatically (see
// routes/auth.js's /register handler); this script exists for the case where
// the account already existed before SUPERADMIN_EMAIL was set, or you want
// to promote someone after the fact.
//
// Usage: npm run seed:superadmin

import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/lib/db/connect.js";
import User from "../src/models/User.js";

async function main() {
  const email = process.env.SUPERADMIN_EMAIL?.toLowerCase();
  if (!email) {
    console.error("Set SUPERADMIN_EMAIL in .env first.");
    process.exit(1);
  }

  await connectDB();
  const user = await User.findOne({ email });

  if (!user) {
    console.error(`No account found for ${email}. Register that account first, then re-run this script.`);
    process.exit(1);
  }

  user.role = "superadmin";
  await user.save();
  console.log(`${email} is now a superadmin.`);

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
