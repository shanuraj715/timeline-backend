import { Router } from "express";
import geoip from "geoip-lite";
import { connectDB } from "../lib/db/connect.js";
import Currency from "../models/Currency.js";
import PricingPlan from "../models/PricingPlan.js";
import { createCurrencySchema, updateCurrencySchema } from "../lib/validation/currency.js";
import { parseJson, badRequest, serverError } from "../lib/apiError.js";
import { requirePermission, notFound, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { currencyForCountry } from "../lib/countryCurrencyMap.js";

export const currencyRouter = Router();
export const publicCurrencyRouter = Router();

currencyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "commerce.currencies");
    if (!admin) return;
    await connectDB();
    const currencies = await Currency.find({}).sort({ order: 1, code: 1 });
    res.json({ currencies });
  })
);

currencyRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.currencies");
    if (!admin) return;

    const data = parseJson(req, res, createCurrencySchema);
    if (!data) return;

    try {
      await connectDB();
      const existing = await Currency.findOne({ code: data.code });
      if (existing) return badRequest(res, "This currency already exists");

      // A default currency that isn't enabled makes no sense as the geo
      // detection fallback every visitor could land on.
      if (data.isDefault) data.isEnabled = true;

      const currency = await Currency.create(data);

      // Every plan must have a price for every currency, enabled or not —
      // seed it at 0 so the admin can fill it in from the Pricing page.
      await PricingPlan.updateMany({}, { $set: { [`prices.${currency.code}`]: 0 } });

      if (currency.isDefault) {
        await Currency.updateMany({ _id: { $ne: currency._id } }, { $set: { isDefault: false } });
      }

      res.status(201).json({ currency });
    } catch (err) {
      if (err?.code === 11000) return badRequest(res, "This currency already exists");
      serverError(res, err, "Failed to create currency");
    }
  })
);

currencyRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.currencies");
    if (!admin) return;

    const data = parseJson(req, res, updateCurrencySchema);
    if (!data) return;

    try {
      await connectDB();
      const currency = await Currency.findById(req.params.id);
      if (!currency) return notFound(res, "Currency not found");

      if (data.isDefault) data.isEnabled = true;

      if (data.isEnabled === false && currency.isDefault) {
        return badRequest(res, "Can't disable the default currency — set another one as default first");
      }
      if (data.isEnabled === false && currency.isEnabled) {
        const enabledCount = await Currency.countDocuments({ isEnabled: true });
        if (enabledCount <= 1) return badRequest(res, "Can't disable the last enabled currency");
      }

      Object.assign(currency, data);
      await currency.save();

      if (data.isDefault) {
        await Currency.updateMany({ _id: { $ne: currency._id } }, { $set: { isDefault: false } });
      }

      res.json({ currency });
    } catch (err) {
      serverError(res, err, "Failed to update currency");
    }
  })
);

currencyRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "commerce.currencies");
    if (!admin) return;

    await connectDB();
    const currency = await Currency.findById(req.params.id);
    if (!currency) return notFound(res, "Currency not found");

    if (currency.isDefault) {
      return badRequest(res, "Can't delete the default currency — set another one as default first");
    }
    if (currency.isEnabled) {
      const enabledCount = await Currency.countDocuments({ isEnabled: true });
      if (enabledCount <= 1) return badRequest(res, "Can't delete the last enabled currency");
    }

    await PricingPlan.updateMany({}, { $unset: { [`prices.${currency.code}`]: "" } });
    await Currency.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  })
);

publicCurrencyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await connectDB();
    const currencies = await Currency.find({ isEnabled: true }).sort({ order: 1, code: 1 });

    const defaultCurrency = currencies.find((c) => c.isDefault) || currencies[0] || null;

    const country = geoip.lookup(clientIp(req))?.country || null;
    const guessedCode = country ? currencyForCountry(country) : null;
    const detected = currencies.find((c) => c.code === guessedCode)?.code || defaultCurrency?.code || null;

    res.json({
      currencies: currencies.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol })),
      detected,
    });
  })
);
