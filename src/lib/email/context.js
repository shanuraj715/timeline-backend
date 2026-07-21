// Builds the full `{variable}` -> value map a template is rendered against:
// user-derived fields (present whenever a target user is known) + site-wide
// constants + whatever event-specific extras the call site supplies. Event-
// specific `vars` always win on key collision, letting a call site override
// a generic value (e.g. a different total_credit snapshot) if it ever needs
// to.
export function buildVariableContext(user, vars = {}) {
  // Prefers the real firstName/lastName fields (added alongside registration's
  // new profile fields) when present, falling back to splitting `name` on
  // the first space — covers any account created before those fields
  // existed, which only ever has `name` populated.
  const userVars = user
    ? {
        fname: user.firstName || (user.name || "").split(" ")[0] || "",
        lname: user.lastName || (user.name || "").split(" ").slice(1).join(" "),
        full_name: user.name || "",
        // No dedicated username field exists on User — the email's local
        // part is the closest sensible stand-in for "how someone would be
        // addressed by a short handle" in template copy.
        username: (user.email || "").split("@")[0] || "",
        email: user.email || "",
        total_credit: String(user.credits ?? 0),
      }
    : {};

  return {
    ...userVars,
    site_name: "MyTimelyne",
    app_url: process.env.APP_URL || "",
    current_year: String(new Date().getFullYear()),
    ...vars,
  };
}
