import { Router } from "express";
import { connectDB } from "../lib/db/connect.js";
import Invitation from "../models/Invitation.js";
import Membership from "../models/Membership.js";
import Timeline from "../models/Timeline.js";
import { getCurrentUser, unauthorized, notFound, clientIp } from "../lib/auth/guards.js";
import { badRequest, serverError } from "../lib/apiError.js";
import { logActivity } from "../lib/logger.js";
import { verifyCsrf } from "../lib/auth/csrf.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const invitationsRouter = Router();

invitationsRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { token } = req.params;
    await connectDB();

    const invitation = await Invitation.findOne({ token })
      .populate("timelineId", "title description slug")
      .populate("invitedBy", "name");
    if (!invitation) return notFound(res, "Invitation not found");

    const expired = invitation.expiresAt.getTime() < Date.now();
    const status = expired && invitation.status === "pending" ? "expired" : invitation.status;

    res.json({
      invitation: {
        status,
        role: invitation.role,
        email: invitation.email,
        timeline: invitation.timelineId
          ? { title: invitation.timelineId.title, description: invitation.timelineId.description }
          : null,
        invitedBy: invitation.invitedBy?.name || "A member",
        emailMatches: invitation.email === user.email,
      },
    });
  })
);

invitationsRouter.post(
  "/:token/accept",
  asyncHandler(async (req, res) => {
    if (!verifyCsrf(req)) return badRequest(res, "Request could not be verified");

    const user = await getCurrentUser(req);
    if (!user) return unauthorized(res);

    const { token } = req.params;
    await connectDB();

    const invitation = await Invitation.findOne({ token });
    if (!invitation) return notFound(res, "Invitation not found");

    if (invitation.status !== "pending") return badRequest(res, "This invitation is no longer valid");
    if (invitation.expiresAt.getTime() < Date.now()) return badRequest(res, "This invitation has expired");
    if (invitation.email !== user.email) {
      return badRequest(res, `This invitation was sent to ${invitation.email}. Log in with that email to accept it.`);
    }

    try {
      const timeline = await Timeline.findOne({ _id: invitation.timelineId, deletedAt: null });
      if (!timeline) return notFound(res, "This timeline no longer exists");

      await Membership.findOneAndUpdate(
        { timelineId: timeline._id, userId: user._id },
        { $set: { role: invitation.role, status: "active", invitedBy: invitation.invitedBy } },
        { upsert: true, new: true }
      );

      invitation.status = "accepted";
      await invitation.save();

      await logActivity({
        userId: user._id,
        timelineId: timeline._id,
        action: "member_joined",
        targetType: "user",
        targetId: user._id,
        ip: clientIp(req),
      });

      res.json({ ok: true, slug: timeline.slug });
    } catch (err) {
      serverError(res, err, "Failed to accept invitation");
    }
  })
);
