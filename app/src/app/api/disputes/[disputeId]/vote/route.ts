import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import {
  asNonEmptyString,
  safeJson,
  validationErrorResponse,
} from "@/lib/api/validation";
import { assertChainBackedTx } from "@/lib/solana/verify";
import { appendLedgerEntry } from "@/lib/ledger";

type Context = { params: { disputeId: string } };

export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  try {
    const { disputeId } = ctx.params;
    const body = await safeJson<Record<string, unknown>>(req);
    const vote = asNonEmptyString(body.vote, "vote");
    const txSignature =
      typeof body.tx_signature === "string" && body.tx_signature.trim()
        ? body.tx_signature.trim()
        : null;
    const voteReason = asNonEmptyString(body.vote_reason, "vote_reason");
    if (txSignature) {
      await assertChainBackedTx(txSignature);
    }

    if (!["buyer", "supplier", "split"].includes(vote)) {
      return NextResponse.json(
        { error: "vote must be buyer, supplier, or split" },
        { status: 400 }
      );
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        assignments: {
          include: { arbiter: true },
        },
      },
    });
    if (!dispute) return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    if (!["under_review", "escalated", "open", "pending_admin_review"].includes(dispute.status)) {
      return NextResponse.json({ error: "Dispute is not accepting votes" }, { status: 409 });
    }

    const assignment = dispute.assignments.find((a) => a.arbiter.user_id === req.user.id);
    if (!assignment) {
      return NextResponse.json({ error: "Only assigned arbiters can vote" }, { status: 403 });
    }

    await prisma.disputeArbiterAssignment.update({
      where: { id: assignment.id },
      data: {
        accepted_at: assignment.accepted_at ?? new Date(),
        voted_at: new Date(),
        vote,
        vote_reason: voteReason,
      },
    });

    await appendLedgerEntry({
      tradeId: dispute.trade_id,
      actorUserId: req.user.id,
      eventType: "dispute_vote_cast",
      referenceTx: txSignature,
      metadata: { dispute_id: dispute.id, vote, vote_reason: voteReason },
    });

    return NextResponse.json({ success: true, dispute_id: dispute.id, vote });
  } catch (error) {
    return validationErrorResponse(error);
  }
});
