import { Router } from "express";
import { getCurrentUser, unauthorized } from "../lib/auth/guards.js";

export const authRouter = Router();

authRouter.get("/me", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return unauthorized(res);
  res.json({ user: user.toSafeJSON() });
});
