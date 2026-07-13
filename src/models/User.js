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
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    avatarUrl: { type: String, default: null },
    role: { type: String, enum: ["user", "superadmin"], default: "user" },

    // Progressive brute-force lockout state.
    failedLoginAttempts: { type: Number, default: 0 },
    lockLevel: { type: Number, default: 0, min: 0, max: 3 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },

    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

UserSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

UserSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    avatarUrl: this.avatarUrl,
    role: this.role,
    createdAt: this.createdAt,
  };
};

export default models.User || model("User", UserSchema);
