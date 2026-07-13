import "dotenv/config";
import express from "express";

const PORT = process.env.PORT || 4000;

const app = express();

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "timeline-backend" });
});

app.listen(PORT, () => {
  console.log(`timeline-backend listening on http://localhost:${PORT}`);
});
