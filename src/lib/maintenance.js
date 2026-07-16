// The maintenance-mode flag is read by the gate middleware on essentially
// every API request (see lib/maintenanceGate.js), so unlike the rest of
// PlatformSettings it's cached in-process instead of hitting Mongo per
// request — a cache miss only happens right after a cold start or right
// after an admin actually flips the toggle (invalidateMaintenanceCache(),
// called from routes/settings.js). The common case (maintenance mode off,
// which is virtually all the time) costs one in-memory boolean check.
import { connectDB } from "./db/connect.js";
import { getPlatformSettings } from "./platformSettings.js";

let cached = null; // { enabled, message } | null

export function invalidateMaintenanceCache() {
  cached = null;
}

export async function getMaintenanceState() {
  if (cached) return cached;

  await connectDB();
  const settings = await getPlatformSettings();
  cached = {
    enabled: Boolean(settings.maintenanceMode?.enabled),
    message: settings.maintenanceMode?.message || "",
  };
  return cached;
}
