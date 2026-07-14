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
import { storagePlansRouter } from "./routes/storagePlans.js";
import { couponsRouter } from "./routes/coupons.js";
import { serverError } from "./lib/apiError.js";

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
app.use("/api/storage-plans", storagePlansRouter);
app.use("/api/coupons", couponsRouter);
app.use("/api/public", publicCmsRouter);
app.use("/api/public/feature-flags", publicFeatureFlagsRouter);
app.use("/api/public/pricing", publicPricingRouter);
app.use("/api/public/payment-gateways", publicPaymentsRouter);

// Catches anything forwarded via asyncHandler's `.catch(next)` from any
// route that didn't already handle its own errors — the equivalent of the
// implicit safety net Next.js route handlers get for free at the framework
// level.
app.use((err, req, res, next) => {
  serverError(res, err, "Something went wrong");
});

app.listen(PORT, () => {
  console.log(`timeline-backend listening on http://localhost:${PORT}`);
});
