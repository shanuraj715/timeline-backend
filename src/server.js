import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { timelinesRouter } from "./routes/timelines.js";
import { invitationsRouter } from "./routes/invitations.js";
import { mediaRouter } from "./routes/media.js";
import { cmsRouter, publicCmsRouter } from "./routes/cms.js";
import { featureFlagsRouter, publicFeatureFlagsRouter } from "./routes/featureFlags.js";
import { pricingRouter, publicPricingRouter } from "./routes/pricing.js";
import { paymentsRouter, publicPaymentsRouter } from "./routes/payments.js";
import { analyticsRouter } from "./routes/analytics.js";
import { themesRouter } from "./routes/themes.js";
import { settingsRouter } from "./routes/settings.js";
import { couponsRouter } from "./routes/coupons.js";
import { recaptchaRouter, publicRecaptchaRouter } from "./routes/recaptcha.js";
import { storageRouter } from "./routes/storage.js";
import { publicMaintenanceRouter } from "./routes/maintenance.js";
import { emailTemplatesRouter } from "./routes/emailTemplates.js";
import { emailProvidersRouter } from "./routes/emailProviders.js";
import { googleOAuthRouter, publicGoogleOAuthRouter } from "./routes/googleOAuth.js";
import { currencyRouter, publicCurrencyRouter } from "./routes/currency.js";
import { adminAccountsRouter } from "./routes/adminAccounts.js";
import { serverError } from "./lib/apiError.js";
import { maintenanceGate } from "./lib/maintenanceGate.js";
import { bootstrapDefaultProvider } from "./lib/storage/index.js";
import { startStorageWorker } from "./lib/storage/worker.js";
import { bootstrapEmailTemplates } from "./lib/email/bootstrap.js";

const PORT = process.env.PORT || 4000;

const app = express();

// The `verify` hook stashes the raw request bytes on req.rawBody for the
// Razorpay webhook route, which must validate its HMAC signature against
// the exact bytes Razorpay signed — a re-serialized req.body could differ
// byte-for-byte even with identical field values. Every other route just
// ignores req.rawBody and uses the parsed req.body as before.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// express.json() throws a SyntaxError (from body-parser) for a malformed
// body before any route handler runs; the original Next.js routes hit the
// same failure mode via `await request.json()` throwing, and returned this
// same 400 shape. Must be declared right after express.json() so it only
// ever catches that specific failure.
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Request body must be valid JSON", code: "BAD_REQUEST" });
  }
  next(err);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "timeline-backend" });
});

// Mounted before every other route so a maintenance-mode block always wins;
// the gate itself allowlists /api/auth, /api/health, and
// /api/public/maintenance (registered right below) so those keep working
// regardless — see lib/maintenanceGate.js for the full reasoning.
app.use(maintenanceGate());
app.use("/api/public/maintenance", publicMaintenanceRouter);

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/timelines", timelinesRouter);
app.use("/api/invitations", invitationsRouter);
app.use("/api/media", mediaRouter);
app.use("/api/cms", cmsRouter);
app.use("/api/feature-flags", featureFlagsRouter);
app.use("/api/pricing", pricingRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/themes", themesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/coupons", couponsRouter);
app.use("/api/recaptcha", recaptchaRouter);
app.use("/api/storage", storageRouter);
app.use("/api/email-templates", emailTemplatesRouter);
app.use("/api/email-providers", emailProvidersRouter);
app.use("/api/google-oauth", googleOAuthRouter);
app.use("/api/currencies", currencyRouter);
app.use("/api/admin-accounts", adminAccountsRouter);
app.use("/api/public", publicCmsRouter);
app.use("/api/public/feature-flags", publicFeatureFlagsRouter);
app.use("/api/public/pricing", publicPricingRouter);
app.use("/api/public/payment-gateways", publicPaymentsRouter);
app.use("/api/public/recaptcha", publicRecaptchaRouter);
app.use("/api/public/google-oauth", publicGoogleOAuthRouter);
app.use("/api/public/currencies", publicCurrencyRouter);

// Catches anything forwarded via asyncHandler's `.catch(next)` from any
// route that didn't already handle its own errors — the equivalent of the
// implicit safety net Next.js route handlers get for free at the framework
// level.
app.use((err, req, res, next) => {
  serverError(res, err, "Something went wrong");
});

bootstrapDefaultProvider()
  .then(() => startStorageWorker())
  .catch((err) => console.error("Failed to bootstrap default storage provider:", err));

bootstrapEmailTemplates().catch((err) => console.error("Failed to bootstrap email templates:", err));

app.listen(PORT, () => {
  console.log(`timeline-backend listening on http://localhost:${PORT}`);
});
