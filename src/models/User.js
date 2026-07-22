import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Not `required` — a Google-only account (see routes/auth.js's
    // /google/callback) has no local password at all. Both places that
    // verify a password (/login, /change-password) guard against a null
    // hash explicitly rather than calling bcrypt.compare against it.
    passwordHash: { type: String, default: null },
    // Google's `sub` claim — set the moment an account signs in with
    // Google, whether that's a brand-new account or linking to an
    // existing password account with the same (Google-verified) email.
    // No `default` (deliberately, not an oversight) — a sparse unique index
    // only excludes documents where the field is truly *absent*, not ones
    // where it's explicitly `null`. A `default: null` here would make every
    // non-Google account explicitly set googleId to null on creation, and
    // the very first one would then permanently occupy the index's one
    // allowed "null" slot — every account created after that would fail
    // to register at all with a duplicate-key error. Leaving the field
    // genuinely unset for non-Google accounts is what makes "any number of
    // accounts with no Google link" actually true.
    googleId: { type: String, index: true, sparse: true, unique: true },
    // `name` is derived (`${firstName} ${lastName}`) at creation and kept
    // as the single source of truth every other read site already uses
    // (admin lists, activity/order/timeline serializers, email template
    // {fname}/{lname} variables, the dashboard greeting, etc.) — adding
    // firstName/lastName without touching all of those.
    //
    // None of the new profile fields are `required` at the schema level,
    // even though the registration API requires them for new signups
    // (see lib/validation/auth.js's registerSchema) — this collection
    // already has real accounts predating this change, and Mongoose
    // `required` is enforced on every `.save()`, not just creation, which
    // would break login/password-change/etc. for every existing account
    // the moment this shipped. API-level (zod) validation is the right
    // place to require these for new signups; the schema just needs to
    // tolerate older documents not having them.
    name: { type: String, required: true, trim: true },
    firstName: { type: String, trim: true, default: null },
    lastName: { type: String, trim: true, default: null },
    dob: { type: Date, default: null },
    gender: { type: String, enum: ["male", "female", "other", "prefer_not_to_say"], default: null },
    phone: { type: String, trim: true, default: null },
    country: { type: String, trim: true, default: null },
    // Full external URL for a Google-sourced avatar (payload.picture — see
    // routes/auth.js's /google/callback), or `/api/auth/avatar/:userId`
    // once the user uploads their own (see avatarKey below). Either way,
    // this is what every consumer actually renders.
    avatarUrl: { type: String, default: null },
    // Storage key for a self-uploaded avatar only — null for a Google
    // avatar (that image lives on Google's CDN, this project never stores
    // it). Always a fixed `avatars/{userId}/avatar.webp` path (see
    // lib/media/avatar.js), so a re-upload overwrites in place rather than
    // needing old-file cleanup the way theme images (which keep their
    // original extension) do.
    avatarKey: { type: String, default: null },
    // "admin" is a limited-permission tier — see lib/permissions.js for the
    // full key catalog and lib/auth/guards.js's requirePermission() for how
    // it's enforced. "superadmin" is a fixed, singular, non-grantable status
    // (implicitly holds every permission) — there's no API path that ever
    // sets this value; it only ever comes from scripts/seedSuperAdmin.js.
    role: { type: String, enum: ["user", "admin", "superadmin"], default: "user" },
    // Only meaningful when role === "admin" — ignored for "user" (no admin
    // access at all) and "superadmin" (implicitly has everything). A flat
    // array of keys rather than a Mongoose enum on each element so adding a
    // new permission later never needs a schema migration.
    permissions: { type: [String], default: [] },

    // Progressive brute-force lockout state.
    failedLoginAttempts: { type: Number, default: 0 },
    lockLevel: { type: Number, default: 0, min: 0, max: 3 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },

    passwordChangedAt: { type: Date, default: null },

    // Platform-level moderation, distinct from the per-account lockout above
    // (which is a temporary, self-clearing brute-force defense) — a ban is
    // deliberate, admin-issued, and stays until an admin reverses it. Checked
    // at login (routes/auth.js) and on every authenticated request
    // (lib/auth/guards.js's getCurrentUser), not just at login, so banning
    // someone mid-session takes effect immediately rather than waiting for
    // their access token to expire.
    banned: { type: Boolean, default: false },
    bannedAt: { type: Date, default: null },
    bannedReason: { type: String, default: null },

    // Google accounts are marked verified immediately at creation (Google's
    // own email_verified claim was already checked in /google/callback) —
    // only password signups ever go through the token flow below. Nothing
    // in the app currently blocks on this being false; it's surfaced to the
    // frontend (toSafeJSON) so it can show a "verify your email" banner,
    // and it closes the account-enumeration-adjacent gap where anyone could
    // previously register — and get a fully active session — under an
    // email address they don't actually control, with zero proof of
    // ownership ever required.
    emailVerified: { type: Boolean, default: false },
    emailVerificationTokenHash: { type: String, default: null, index: true },
    emailVerificationExpiresAt: { type: Date, default: null },

    credits: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

UserSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

// Only ever returned for a user's *own* account (register/login/`/me`),
// never someone else's — safe to include the profile fields here even
// though they're more sensitive than what admin list views expose about
// other users.
UserSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    firstName: this.firstName,
    lastName: this.lastName,
    dob: this.dob,
    gender: this.gender,
    phone: this.phone,
    country: this.country,
    avatarUrl: this.avatarUrl,
    role: this.role,
    permissions: this.permissions,
    emailVerified: this.emailVerified,
    credits: this.credits,
    createdAt: this.createdAt,
    // Google signup (see routes/auth.js's /google/callback) can't collect
    // dob/gender the way registerSchema does for password signups — this
    // tells the frontend to route a Google-linked account through
    // /complete-profile until it has both. Scoped to googleId specifically
    // so it never fires for legacy password accounts that predate the
    // dob/gender requirement (those were never asked and aren't being
    // retroactively forced to answer now).
    needsProfileCompletion: Boolean(this.googleId) && !(this.dob && this.gender),
  };
};

export default models.User || model("User", UserSchema);
