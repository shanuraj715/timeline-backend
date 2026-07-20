// Per-timeline RBAC. A user's role is scoped to a single Membership doc —
// the same user can be "owner" of one timeline and "viewer" of another.

export const ROLES = ["viewer", "editor", "admin", "owner"];

const RANK = Object.fromEntries(ROLES.map((role, i) => [role, i]));

export function roleAtLeast(role, minimum) {
  if (!role || !(role in RANK)) return false;
  return RANK[role] >= RANK[minimum];
}

export const permissions = {
  viewTimeline: (role) => roleAtLeast(role, "viewer"),
  viewMedia: (role) => roleAtLeast(role, "viewer"),
  search: (role) => roleAtLeast(role, "viewer"),

  uploadMedia: (role) => roleAtLeast(role, "editor"),
  editMediaMetadata: (role) => roleAtLeast(role, "editor"),
  deleteMedia: (role) => roleAtLeast(role, "editor"),
  restoreMedia: (role) => roleAtLeast(role, "editor"),
  changeTimelineTheme: (role) => roleAtLeast(role, "editor"),
  manageTimelineStorage: (role) => roleAtLeast(role, "editor"),

  editTimelineDetails: (role) => roleAtLeast(role, "admin"),
  inviteMembers: (role) => roleAtLeast(role, "admin"),
  removeMembers: (role) => roleAtLeast(role, "admin"),
  changeMemberRole: (role) => roleAtLeast(role, "admin"),
  viewActivityLog: (role) => roleAtLeast(role, "admin"),

  deleteTimeline: (role) => roleAtLeast(role, "owner"),
  transferOwnership: (role) => roleAtLeast(role, "owner"),
  viewViewerAnalytics: (role) => roleAtLeast(role, "owner"),
};

export function canAssignRole(actorRole, targetRole) {
  // Admins can grant up to "admin" but not create/demote other owners.
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return targetRole !== "owner";
  return false;
}
