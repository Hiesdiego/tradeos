import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { validationErrorResponse } from "@/lib/api/validation";
import { appendLedgerEntry } from "@/lib/ledger";

type Context = { params: { disputeId: string } };

export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  try {
    const { disputeId } = ctx.params;

    const arbiterProfile = await prisma.arbiterProfile.findUnique({
      where: { user_id: req.user.id },
      select: {
        id: true,
        active: true,
        min_case_amount_usdc: true,
        max_case_amount_usdc: true,
      },
    });
    if (!arbiterProfile?.active) {
      return NextResponse.json({ error: "Active arbiter profile required" }, { status: 403 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { id: disputeId },
        include: {
          trade: true,
          assignments: true,
        },
      });
      if (!dispute) return { error: "Dispute not found", status: 404 as const };
      if (dispute.status !== "open") {
        return { error: "Dispute is not open for arbiter claim", status: 409 as const };
      }
      if (dispute.panel_signup_deadline && new Date() > dispute.panel_signup_deadline) {
        return { error: "Claim window closed for this dispute", status: 409 as const };
      }

      const tradeAmount = Number(dispute.trade.total_amount_usdc);
      const minCase = Number(arbiterProfile.min_case_amount_usdc);
      const maxCase = arbiterProfile.max_case_amount_usdc == null ? null : Number(arbiterProfile.max_case_amount_usdc);
      if (tradeAmount < minCase || (maxCase !== null && tradeAmount > maxCase)) {
        return { error: "Case amount is outside your arbiter range", status: 403 as const };
      }
      if (dispute.trade.buyer_id === req.user.id || dispute.trade.supplier_id === req.user.id) {
        return { error: "Trade parties cannot arbitrate their own dispute", status: 403 as const };
      }
      if (dispute.assignments.some((a) => a.arbiter_profile_id === arbiterProfile.id)) {
        return { error: "Already claimed by this arbiter", status: 409 as const };
      }
      if (dispute.assignments.length >= dispute.panel_size) {
        return { error: "Arbiter panel is already full", status: 409 as const };
      }

      await tx.disputeArbiterAssignment.create({
        data: {
          dispute_id: dispute.id,
          arbiter_profile_id: arbiterProfile.id,
          accepted_at: new Date(),
        },
      });
      await tx.arbiterProfile.update({
        where: { id: arbiterProfile.id },
        data: { accepted_cases: { increment: 1 } },
      });

      const count = dispute.assignments.length + 1;
      if (count >= dispute.panel_size) {
        await tx.dispute.update({
          where: { id: dispute.id },
          data: { status: "under_review", panel_locked_at: new Date() },
        });
      }

      return { ok: true as const, tradeId: dispute.trade_id, claimCount: count, panelSize: dispute.panel_size };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await appendLedgerEntry({
      tradeId: result.tradeId,
      actorUserId: req.user.id,
      eventType: "dispute_escalated",
      metadata: {
        action: "arbiter_claimed",
        claim_count: result.claimCount,
        panel_size: result.panelSize,
      },
    });

    return NextResponse.json({ success: true, claim_count: result.claimCount, panel_size: result.panelSize });
  } catch (error) {
    return validationErrorResponse(error);
  }
});
