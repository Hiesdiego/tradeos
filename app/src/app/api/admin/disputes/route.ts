import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { isAdminWallet } from "@/lib/constants";

// GET /api/admin/disputes - list all disputes for arbiter review
export const GET = withAuth(async (req: AuthedRequest) => {
  if (!isAdminWallet(req.walletAddress)) {
    return NextResponse.json(
      { error: "Only admin wallets can view disputes" },
      { status: 403 }
    );
  }

  const disputes = await prisma.dispute.findMany({
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

  return NextResponse.json(disputes);
});
