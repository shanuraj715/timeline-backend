// One key per admin-panel tab — granting a permission means full access to
// that whole tab (view/create/edit/delete alike), not a partial/read-only
// slice. `platform.admins` is the odd one out: it's the "manage other admin
// accounts' permissions" capability, and carries extra grant-scope/peer-
// protection rules enforced in routes/adminAccounts.js, not just a plain
// gate like every other key here.
export const PERMISSION_GROUPS = [
  {
    key: "dashboard",
    label: "Dashboard",
    permissions: [{ key: "dashboard", label: "Dashboard" }],
  },
  {
    key: "content",
    label: "Content",
    permissions: [
      { key: "content.navigation", label: "Navigation" },
      { key: "content.footer", label: "Footer" },
      { key: "content.pages", label: "Pages" },
      { key: "content.homepage", label: "Homepage" },
      { key: "content.branding", label: "Branding" },
      { key: "content.themes", label: "Themes" },
    ],
  },
  {
    key: "commerce",
    label: "Commerce",
    permissions: [
      { key: "commerce.pricing", label: "Pricing plans" },
      { key: "commerce.creditCosts", label: "Credit costs" },
      { key: "commerce.currencies", label: "Currencies" },
      { key: "commerce.coupons", label: "Coupons" },
      { key: "commerce.gateways", label: "Payment gateways" },
      { key: "commerce.orders", label: "Orders" },
    ],
  },
  {
    key: "platform",
    label: "Platform",
    permissions: [
      { key: "platform.users", label: "Users" },
      { key: "platform.timelines", label: "Timelines" },
      { key: "platform.storage", label: "Storage" },
      { key: "platform.system", label: "System health" },
      { key: "platform.security", label: "Security log" },
      { key: "platform.flags", label: "Feature flags" },
      { key: "platform.settings", label: "Settings" },
      { key: "platform.admins", label: "Admins" },
    ],
  },
  {
    key: "notifications",
    label: "Notifications",
    permissions: [
      { key: "notifications.templates", label: "Email templates" },
      { key: "notifications.providers", label: "Email providers" },
    ],
  },
];

export const PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));

export function isValidPermission(key) {
  return PERMISSION_KEYS.includes(key);
}
