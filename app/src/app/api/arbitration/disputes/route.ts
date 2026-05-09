import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { isAdminWallet } from "@/lib/constants";

export const GET = withAuth(async (req: AuthedRequest) => {
  const admin = isAdminWallet(req.walletAddress);
  const arbiterProfile = await prisma.arbiterProfile.findUnique({
    where: { user_id: req.user.id },
    select: { id: true, active: true },
  });

  if (!admin && !arbiterProfile?.active) {
    return NextResponse.json(
      { error: "Only active arbiters or admins can view arbitration disputes" },
      { status: 403 }
    );
  }

  const disputes = await prisma.dispute.findMany({
    where: admin ? undefined : { status: { in: ["open", "under_review", "escalated", "pending_admin_review"] } },
    include: {
      trade: {
        include: {
          buyer: true,
          supplier: true,
          milestones: {
            select: {
              milestone_number: true,
              proof_url: true,
              status: true,
            },
            orderBy: { milestone_number: "asc" },
          },
        },
      },
      raiser: true,
      assignments: {
        include: {
          arbiter: {
            include: { user: true },
          },
        },
      },
    },
    orderBy: { created_at: "desc" },
  });

  if (admin) return NextResponse.json(disputes);

  const filtered = disputes.filter((d) => {
    const assigned = d.assignments.some((a) => a.arbiter_profile_id === arbiterProfile!.id);
    if (assigned) return true;
    if (d.status !== "open") return false;
    if (d.assignments.length >= d.panel_size) return false;
    if (d.panel_signup_deadline && new Date() > d.panel_signup_deadline) return false;
    if (d.trade.buyer.id === req.user.id || d.trade.supplier?.id === req.user.id) return false;
    return true;
  });

  return NextResponse.json(filtered);
});
