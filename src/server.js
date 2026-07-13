import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { timelinesRouter } from "./routes/timelines.js";
import { invitationsRouter } from "./routes/invitations.js";
import { mediaRouter } from "./routes/media.js";
import { serverError } from "./lib/apiError.js";

const PORT = process.env.PORT || 4000;

const app = express();

app.use(express.json());
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
