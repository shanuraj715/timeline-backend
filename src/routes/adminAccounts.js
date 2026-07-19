import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import User from "../models/User.js";
import { grantAdminAccessSchema, updateAdminPermissionsSchema } from "../lib/validation/adminAccounts.js";
import { parseJson, badRequest } from "../lib/apiError.js";
import { requirePermission, notFound, forbidden, clientIp } from "../lib/auth/guards.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logSecurityEvent } from "../lib/logger.js";
import { revokeAllSessionsForUser } from "../lib/auth/session.js";
import { hashPassword } from "../lib/auth/password.js";

// Manages *other* admin/superadmin accounts — separate from routes/admin.js's
// plain customer-account moderation (unlock/credits/view-timelines), and
// gated by its own special permission ("platform.admins") with two extra
// rules layered on top of the normal single-permission check, confirmed with
// the user up front:
//   1. An account can only grant/revoke permissions it itself already holds
//      — a superadmin holds everything implicitly and is exempt from this.
//   2. Only the real superadmin can edit/revoke an account that itself holds
//      "platform.admins" — two permission-managers can't touch each other.
// The superadmin account itself is never a valid target for any route here
// (it's not grantable/revocable at all — scripts/seedSuperAdmin.js only),
// and nobody can touch their own admin access through this route either.
export const adminAccountsRouter = Router();

function serializeAccount(target, caller) {
  const isSelf = target._id.equals(caller._id);
  const isSuperadmin = target.role === "superadmin";
  const targetManagesAdmins = target.permissions?.includes("platform.admins");

  const canManage = isSelf || isSuperadmin ? false : caller.role === "superadmin" || !targetManagesAdmins;

  return {
    id: target._id.toString(),
    email: target.email,
    name: target.name,
    role: target.role,
    permissions: target.permissions || [],
    createdAt: target.createdAt,
    canManage,
  };
}

function assertGrantableByCallerScope(caller, permissions, res) {
  if (caller.role === "superadmin") return true;
  const notAllowed = permissions.filter((p) => !caller.permissions.includes(p));
  if (notAllowed.length > 0) {
    badRequest(res, `You can't grant permissions you don't have: ${notAllowed.join(", ")}`);
    return false;
  }
  return true;
}

// Returns false (and writes the response) if `target` isn't a valid
// managed-by-`caller` account — shared by the update/revoke routes.
function assertManageable(caller, target, res) {
  if (!target) {
    notFound(res, "Account not found");
    return false;
  }
  if (target.role === "superadmin") {
    forbidden(res, "The superadmin account can't be modified");
    return false;
  }
  if (target._id.equals(caller._id)) {
    badRequest(res, "You can't change your own admin access");
    return false;
  }
  if (caller.role !== "superadmin" && target.permissions.includes("platform.admins")) {
    forbidden(res, "Only the superadmin can manage an account that can itself manage admins");
    return false;
  }
  return true;
}

adminAccountsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const admin = await requirePermission(req, res, "platform.admins");
    if (!admin) return;

    await connectDB();
    const accounts = await User.find({ role: { $in: ["admin", "superadmin"] } }).sort({ createdAt: 1 });
    res.json({ accounts: accounts.map((a) => serializeAccount(a, admin)) });
  })
);

adminAccountsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.admins");
    if (!admin) return;

    const data = parseJson(req, res, grantAdminAccessSchema);
    if (!data) return;
    if (!assertGrantableByCallerScope(admin, data.permissions, res)) return;

    await connectDB();
    const existing = await User.findOne({ email: data.email });

    if (existing) {
      if (!assertManageable(admin, existing, res)) return;
      existing.role = "admin";
      existing.permissions = data.permissions;
      await existing.save();
      await logSecurityEvent({
        userId: admin._id,
        action: "admin_granted_permissions",
        ip: clientIp(req),
        metadata: { targetUserId: existing._id.toString(), permissions: data.permissions },
      });
      return res.json({ account: serializeAccount(existing, admin) });
    }

    if (!data.password) return badRequest(res, "A password is required to create a new account");
    if (!data.name) return badRequest(res, "A name is required to create a new account");

    const passwordHash = await hashPassword(data.password);
    const created = await User.create({
      email: data.email,
      name: data.name,
      passwordHash,
      role: "admin",
      permissions: data.permissions,
    });
    await logSecurityEvent({
      userId: admin._id,
      action: "admin_created_admin_account",
      ip: clientIp(req),
      metadata: { targetUserId: created._id.toString(), permissions: data.permissions },
    });
    res.status(201).json({ account: serializeAccount(created, admin) });
  })
);

adminAccountsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.admins");
    if (!admin) return;

    const data = parseJson(req, res, updateAdminPermissionsSchema);
    if (!data) return;

    await connectDB();
    const target = await User.findById(req.params.id);
    if (!assertManageable(admin, target, res)) return;
    if (!assertGrantableByCallerScope(admin, data.permissions, res)) return;

    target.permissions = data.permissions;
    await target.save();

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_updated_permissions",
      ip: clientIp(req),
      metadata: { targetUserId: target._id.toString(), permissions: data.permissions },
    });
    res.json({ account: serializeAccount(target, admin) });
  })
);

adminAccountsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");
    const admin = await requirePermission(req, res, "platform.admins");
    if (!admin) return;

    await connectDB();
    const target = await User.findById(req.params.id);
    if (!assertManageable(admin, target, res)) return;

    target.role = "user";
    target.permissions = [];
    await target.save();
    await revokeAllSessionsForUser(target._id, "admin_access_revoked");

    await logSecurityEvent({
      userId: admin._id,
      action: "admin_revoked_admin_access",
      ip: clientIp(req),
      metadata: { targetUserId: target._id.toString() },
    });
    res.json({ ok: true });
  })
);
