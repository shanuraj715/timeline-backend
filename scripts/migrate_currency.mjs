import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/lib/db/connect.js";
import Currency from "../src/models/Currency.js";
import PricingPlan from "../src/models/PricingPlan.js";

const SEED_CURRENCIES = [
  { code: "INR", name: "Indian Rupee", symbol: "₹", isEnabled: true, isDefault: true, order: 0 },
  { code: "USD", name: "US Dollar", symbol: "$", isEnabled: false, isDefault: false, order: 1 },
  { code: "EUR", name: "Euro", symbol: "€", isEnabled: false, isDefault: false, order: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", isEnabled: false, isDefault: false, order: 3 },
  { code: "AED", name: "UAE Dirham", symbol: "AED", isEnabled: false, isDefault: false, order: 4 },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$", isEnabled: false, isDefault: false, order: 5 },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", isEnabled: false, isDefault: false, order: 6 },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$", isEnabled: false, isDefault: false, order: 7 },
];

await connectDB();

console.log("=== Seeding Currency collection ===");
for (const c of SEED_CURRENCIES) {
  const existing = await Currency.findOne({ code: c.code });
  if (existing) {
    console.log(`  ${c.code}: already exists, skipping`);
    continue;
  }
  await Currency.create(c);
  console.log(`  ${c.code}: created (enabled=${c.isEnabled}, default=${c.isDefault})`);
}

console.log("\n=== Migrating PricingPlan documents ===");
// Read raw (not through the Mongoose model) since the model no longer
// declares priceInPaise/currency — need the collection driver to see them.
const rawPlans = await mongoose.connection.collection("pricingplans").find({}).toArray();

for (const raw of rawPlans) {
  if (raw.prices && Object.keys(raw.prices).length > 0) {
    console.log(`  ${raw.name}: already migrated, skipping`);
    continue;
  }
  const oldPriceInPaise = raw.priceInPaise;
  const oldCurrency = raw.currency || "INR";

  const prices = {};
  for (const c of SEED_CURRENCIES) {
    prices[c.code] = c.code === oldCurrency ? oldPriceInPaise : 0;
  }

  await mongoose.connection.collection("pricingplans").updateOne(
    { _id: raw._id },
    {
      $set: { prices },
      $unset: { priceInPaise: "", currency: "" },
    }
  );
  console.log(`  ${raw.name}: ${oldCurrency} ${oldPriceInPaise} -> prices.${oldCurrency} = ${oldPriceInPaise} (others = 0)`);
}

console.log("\n=== Done ===");
process.exit(0);
