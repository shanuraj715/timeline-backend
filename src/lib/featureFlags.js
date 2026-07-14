import FeatureFlag from "../models/FeatureFlag.js";

/**
 * Fail-open by design: a flag that hasn't been seeded/created yet is
 * treated as enabled, so a brand-new deployment (or a flag key nobody's
 * gotten around to defining yet) never silently blocks existing behavior.
 * Only an explicit `enabled: false` document turns a feature off.
 */
export async function isFeatureEnabled(key) {
  const flag = await FeatureFlag.findOne({ key });
  if (!flag) return true;
  return flag.enabled;
}

export const STARTER_FLAGS = [
  {
    key: "registration_enabled",
    label: "New user registration",
    description: "Allow new visitors to create an account.",
  },
  {
    key: "uploads_enabled",
    label: "Media uploads",
    description: "Allow members to upload photos/videos to timelines.",
  },
  {
    key: "invitations_enabled",
    label: "Timeline invitations",
    description: "Allow timeline admins/owners to invite new members.",
  },
  {
    key: "pricing_page_enabled",
    label: "Pricing / buy credits page",
    description: "Show the public pricing page and allow credit purchases.",
  },
  {
    key: "search_enabled",
    label: "Search",
    description: "Allow searching media within a timeline.",
  },
];
