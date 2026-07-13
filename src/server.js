import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth.js";

const PORT = process.env.PORT || 4000;

const app = express();

app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "timeline-backend" });
});

app.use("/api/auth", authRouter);

app.listen(PORT, () => {
  console.log(`timeline-backend listening on http://localhost:${PORT}`);
});
