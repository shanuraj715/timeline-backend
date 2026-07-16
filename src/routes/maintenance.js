import { Router } from "express";
import { getMaintenanceState } from "../lib/maintenance.js";
import { asyncHandler } from "../lib/asyncHandler.js";

// Unauthenticated by design — this is exactly what a logged-out visitor's
// maintenance screen polls to find out the moment it's safe to reload, and
// it's one of the few routes exempt from the maintenance gate itself (see
// lib/maintenanceGate.js) since otherwise it could never report the site
// coming back.
export const publicMaintenanceRouter = Router();

publicMaintenanceRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const state = await getMaintenanceState();
    res.json({ enabled: state.enabled, message: state.message });
  })
);
