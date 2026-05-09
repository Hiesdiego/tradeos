import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import {
  asNonEmptyString,
  asPositiveInt,
  safeJson,
  validationErrorResponse,
} from "@/lib/api/validation";
import { notifyDisputeRaised } from "@/lib/telegram/notifications";
import { assertChainBackedTx } from "@/lib/solana/verify";
import type { Trade } from "@/types";
import { appendLedgerEntry } from "@/lib/ledger";
import {
  computeArbitrationFeeUsdc,
  computeSlaDeadlines,
  DEFAULT_PANEL_SIZE,
  getAdminOverrideDeadline,
} from "@/lib/arbitration.shared";

type Context = { params: { tradeId: string } };

// POST /api/trades/[tradeId]/dispute — open a dispute on a milestone
export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  try {
    const { tradeId } = ctx.params;
    const body = await safeJson<Record<string, unknown>>(req);
    const reason = asNonEmptyString(body.reason, "reason");
    const milestone_number =
      body.milestone_number !== undefined
        ? asPositiveInt(body.milestone_number, "milestone_number")
        : undefined;
    const tx_signature =
      typeof body.tx_signature === "string" && body.tx_signature.trim().length > 0
        ? body.tx_signature.trim()
        : null;
    if (tx_signature) {
      await assertChainBackedTx(tx_signature);
    }

    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      include: { buyer: true, supplier: true },
    });
    if (!trade) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    }

    const isMember =
      trade.buyer_id === req.user.id || trade.supplier_id === req.user.id;
    if (!isMember) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (["completed", "cancelled", "refunded", "disputed"].includes(trade.status)) {
      return NextResponse.json(
        { error: "Cannot raise dispute on a closed trade" },
        { status: 400 }
      );
    }

    let milestoneId: string | undefined;
    if (milestone_number) {
      const milestone = await prisma.milestone.findUnique({
        where: {
          trade_id_milestone_number: {
            trade_id: tradeId,
            milestone_number,
          },
        },
      });
      if (!milestone) {
        return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
      }
      milestoneId = milestone.id;
    }

    const now = new Date();
    const { evidenceDeadline, decisionDeadline } = computeSlaDeadlines(now);
    const milestoneAmountUsdc =
      milestoneId && milestone_number
        ? Number(
            (
              await prisma.milestone.findUnique({
                where: {
                  trade_id_milestone_number: {
                    trade_id: tradeId,
                    milestone_number,
                  },
                },
                select: { release_amount_usdc: true },
              })
            )?.release_amount_usdc ?? trade.total_amount_usdc
          )
        : Number(trade.total_amount_usdc);
    const arbitrationFeeUsdc = computeArbitrationFeeUsdc(milestoneAmountUsdc);
    const feeRateBps = milestoneAmountUsdc > 0 ? Math.round((arbitrationFeeUsdc * 10_000) / milestoneAmountUsdc) : 0;
    const adminOverrideDeadline = getAdminOverrideDeadline(now);
    const panelSize = DEFAULT_PANEL_SIZE;
    const signupHoursRaw = Number(process.env.ARBITRATION_PANEL_SIGNUP_HOURS ?? 24);
    const signupHours = Number.isFinite(signupHoursRaw) ? Math.max(1, Math.round(signupHoursRaw)) : 24;
    const panelSignupDeadline = new Date(now.getTime() + signupHours * 60 * 60 * 1000);

    const dispute = await prisma.$transaction(async (tx) => {
      const created = await tx.dispute.create({
        data: {
          trade_id: tradeId,
          milestone_id: milestoneId ?? null,
          raised_by: req.user.id,
          reason,
          status: "open",
          arbiter_notes: tx_signature ? `chain_tx:${tx_signature}` : "offchain_dispute",
          arbitration_fee_usdc: arbitrationFeeUsdc,
          arbitration_fee_rate_bps: feeRateBps,
          arbitration_fee_source: "reserve",
          panel_size: panelSize,
          escalation_level: 1,
          accepted_at: now,
          panel_signup_deadline: panelSignupDeadline,
          evidence_deadline: evidenceDeadline,
          decision_deadline: decisionDeadline,
          admin_override_deadline: adminOverrideDeadline,
          requires_admin_review: true,
          auto_enforce_after_deadline: true,
        },
      });

      await tx.trade.update({
        where: { id: tradeId },
        data: {
          status: "disputed",
          arbitration_fee_reserve_usdc: { increment: arbitrationFeeUsdc },
          arbitration_fee_rate_bps: feeRateBps,
        },
      });

      if (milestoneId) {
        await tx.milestone.update({
          where: { id: milestoneId },
          data: { status: "disputed" },
        });
      }

      await tx.reputationEvent.create({
        data: {
          user_id: req.user.id,
          trade_id: tradeId,
          event_type: "dispute_opened",
          score_delta: -0.3,
        },
      });
      return created;
    });

    await notifyDisputeRaised(
      trade.buyer_id,
      trade.buyer?.telegram_chat_id,
      trade.supplier_id,
      trade.supplier?.telegram_chat_id,
      process.env.ARBITER_TELEGRAM_CHAT_ID,
      trade as unknown as Trade,
      trade.buyer_id === req.user.id ? "buyer" : "supplier",
      reason
    );

    await appendLedgerEntry({
      tradeId,
      actorUserId: req.user.id,
      eventType: "dispute_opened",
      referenceTx: tx_signature,
      metadata: {
        dispute_id: dispute.id,
        reason,
        milestone_number: milestone_number ?? null,
        dispute_raise_mode: tx_signature ? "onchain_verified" : "offchain_fallback",
      },
    });
    await appendLedgerEntry({
      tradeId,
      actorUserId: req.user.id,
      eventType: "arbitration_fee_charged",
      amountUsdc: arbitrationFeeUsdc,
      referenceTx: tx_signature,
      metadata: {
        dispute_id: dispute.id,
        panel_size: panelSize,
        fee_rate_bps: feeRateBps,
        fee_source: "reserve",
      },
    });

    return NextResponse.json(dispute, { status: 201 });
  } catch (error) {
    return validationErrorResponse(error);
  }
});
