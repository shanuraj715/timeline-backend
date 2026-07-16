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
    // sparse so any number of accounts with no Google link can all have
    // googleId: null without violating the unique index.
    googleId: { type: String, default: null, index: true, sparse: true, unique: true },
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
    avatarUrl: { type: String, default: null },
    role: { type: String, enum: ["user", "superadmin"], default: "user" },

    // Progressive brute-force lockout state.
    failedLoginAttempts: { type: Number, default: 0 },
    lockLevel: { type: Number, default: 0, min: 0, max: 3 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },

    passwordChangedAt: { type: Date, default: null },

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
    credits: this.credits,
    createdAt: this.createdAt,
  };
};

export default models.User || model("User", UserSchema);
