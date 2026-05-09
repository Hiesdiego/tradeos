import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { applyReputationEvent } from "@/lib/reputation";
import { notifyDisputeResolved } from "@/lib/telegram/notifications";
import type { Trade } from "@/types";
import {
  asNonEmptyString,
  safeJson,
  validationErrorResponse,
} from "@/lib/api/validation";
import { assertChainBackedTx } from "@/lib/solana/verify";
import { appendLedgerEntry, computeReceiptHash } from "@/lib/ledger";
import { isAdminWallet } from "@/lib/constants";
import { resolveVoteMajority, type ResolutionVote } from "@/lib/arbitration.shared";

type Context = { params: { disputeId: string } };

// POST /api/disputes/[disputeId]/resolve — arbiter resolves a dispute
export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  try {
    const { disputeId } = ctx.params;
    const body = await safeJson<Record<string, unknown>>(req);
    const requestedResolution =
      typeof body.resolution === "string" ? body.resolution : null;
    const adminOverrideReason =
      typeof body.admin_override_reason === "string" ? body.admin_override_reason.trim() : "";
    const overridePolicyCode =
      typeof body.override_policy_code === "string" ? body.override_policy_code.trim() : "";
    const arbiter_notes =
      typeof body.arbiter_notes === "string" ? body.arbiter_notes : null;
    const tx_signature = asNonEmptyString(body.tx_signature, "tx_signature");
    await assertChainBackedTx(tx_signature);
    const isAdmin = isAdminWallet(req.walletAddress);

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        trade: { include: { buyer: true, supplier: true } },
        assignments: {
          include: {
            arbiter: true,
          },
        },
      },
    });

    if (!dispute) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }
    if (!["open", "under_review", "escalated", "pending_admin_review"].includes(dispute.status)) {
      return NextResponse.json(
        { error: "Dispute has already been resolved" },
        { status: 409 }
      );
    }

    const assignedArbiter = dispute.assignments.find(
      (a) => a.arbiter.user_id === req.user.id
    );
    if (!isAdmin && !assignedArbiter) {
      return NextResponse.json(
        { error: "Only assigned arbiters or admin can resolve disputes" },
        { status: 403 }
      );
    }

    const statusMap: Record<
      string,
      "resolved_buyer" | "resolved_supplier" | "resolved_split"
    > = {
      buyer: "resolved_buyer",
      supplier: "resolved_supplier",
      split: "resolved_split",
    };

    const votes = dispute.assignments
      .map((a) => a.vote)
      .filter((v): v is ResolutionVote => Boolean(v)) as ResolutionVote[];
    const panelReady = dispute.assignments.length >= dispute.panel_size;
    if (!panelReady) {
      return NextResponse.json(
        { error: "Panel is not full yet; awaiting arbiter claims" },
        { status: 409 }
      );
    }
    const quorum = Math.ceil(dispute.panel_size / 2);
    if (votes.length < quorum) {
      return NextResponse.json(
        { error: `Insufficient quorum: ${votes.length}/${quorum}` },
        { status: 409 }
      );
    }
    const majorityResolution = resolveVoteMajority(votes);
    const now = new Date();
    const adminWindowExpired =
      dispute.admin_override_deadline && now > dispute.admin_override_deadline;
    const resolution = isAdmin ? requestedResolution ?? majorityResolution : majorityResolution;
    if (!resolution) {
      return NextResponse.json(
        { error: "No majority resolution yet; panel vote tie or insufficient votes" },
        { status: 409 }
      );
    }

    const disputeStatus = statusMap[resolution];
    if (!disputeStatus) {
      return NextResponse.json(
        { error: "resolution must be buyer, supplier, or split" },
        { status: 400 }
      );
    }

    const trade = dispute.trade;
    if (!isAdmin && !adminWindowExpired) {
      await prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status: "pending_admin_review",
          panel_resolution: resolution,
          arbiter_notes: `${arbiter_notes ?? ""}${arbiter_notes ? "\n" : ""}panel_chain_tx:${tx_signature}`,
        },
      });
      return NextResponse.json({
        success: true,
        status: "pending_admin_review",
        panel_resolution: resolution,
        admin_override_deadline: dispute.admin_override_deadline,
      });
    }

    const overridingPanel = Boolean(
      isAdmin &&
        requestedResolution &&
        majorityResolution &&
        requestedResolution !== majorityResolution
    );
    if (overridingPanel && (!adminOverrideReason || !overridePolicyCode)) {
      return NextResponse.json(
        {
          error:
            "Admin override requires admin_override_reason and override_policy_code",
        },
        { status: 400 }
      );
    }

    const loserId = resolution === "buyer" ? trade.supplier_id : trade.buyer_id;
    const winnerId = resolution === "buyer" ? trade.buyer_id : trade.supplier_id;
    const finalTradeStatus = resolution === "buyer" ? "refunded" : "completed";

    let finalDisputeStatus:
      | "resolved_buyer"
      | "resolved_supplier"
      | "resolved_split"
      | "resolved_overridden_buyer"
      | "resolved_overridden_supplier"
      | "resolved_overridden_split";
    if (overridingPanel && isAdmin) {
      finalDisputeStatus =
        resolution === "buyer"
          ? "resolved_overridden_buyer"
          : resolution === "supplier"
          ? "resolved_overridden_supplier"
          : "resolved_overridden_split";
    } else {
      finalDisputeStatus = disputeStatus;
    }

    await Promise.all([
      prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status: finalDisputeStatus,
          arbiter_notes: `${arbiter_notes ?? ""}${
            arbiter_notes ? "\n" : ""
          }chain_tx:${tx_signature}`,
          panel_resolution: majorityResolution ?? null,
          final_resolution: resolution,
          finalized_by_user_id: req.user.id,
          admin_override_by_user_id: overridingPanel ? req.user.id : null,
          admin_override_reason: overridingPanel
            ? `${overridePolicyCode}: ${adminOverrideReason}`
            : null,
          resolved_at: new Date(),
        },
      }),
      prisma.trade.update({
        where: { id: trade.id },
        data: { status: finalTradeStatus },
      }),
      dispute.milestone_id
        ? prisma.milestone.update({
            where: { id: dispute.milestone_id },
            data: { status: resolution === "buyer" ? "pending" : "released" },
          })
        : Promise.resolve(),
      prisma.tradeReceipt.upsert({
        where: { trade_id: trade.id },
        create: { trade_id: trade.id, tx_signature },
        update: { tx_signature },
      }),
    ]);

    const perArbiterFee = dispute.assignments.length
      ? Number((Number(dispute.arbitration_fee_usdc) / dispute.assignments.length).toFixed(6))
      : 0;
    if (perArbiterFee > 0 && dispute.assignments.length > 0) {
      for (const assignment of dispute.assignments) {
        await prisma.$transaction([
          prisma.arbiterProfile.update({
            where: { id: assignment.arbiter_profile_id },
            data: {
              resolved_cases: { increment: 1 },
              total_earnings_usdc: { increment: perArbiterFee },
            },
          }),
          prisma.disputeArbiterAssignment.update({
            where: { id: assignment.id },
            data: { fee_share_usdc: perArbiterFee, paid_out: true },
          }),
        ]);

        await appendLedgerEntry({
          tradeId: trade.id,
          actorUserId: assignment.arbiter.user_id,
          eventType: "arbiter_fee_allocated",
          amountUsdc: perArbiterFee,
          referenceTx: tx_signature,
          metadata: {
            dispute_id: disputeId,
            arbiter_profile_id: assignment.arbiter_profile_id,
          },
        });
      }
    }

    if (loserId) {
      await applyReputationEvent({
        userId: loserId,
        tradeId: trade.id,
        eventType: "dispute_ruled_against",
        scoreDelta: -0.5,
      });
    }
    if (winnerId && resolution !== "split") {
      await applyReputationEvent({
        userId: winnerId,
        tradeId: trade.id,
        eventType: "dispute_ruled_in_favor",
        scoreDelta: 0.1,
      });
    }

    notifyDisputeResolved(
      trade.buyer_id,
      trade.buyer?.telegram_chat_id,
      trade.supplier_id,
      trade.supplier?.telegram_chat_id,
      trade as unknown as Trade,
      resolution as "buyer" | "supplier" | "split",
      arbiter_notes
    ).catch(() => undefined);

    await appendLedgerEntry({
      tradeId: trade.id,
      actorUserId: req.user.id,
      eventType: "dispute_resolved",
      referenceTx: tx_signature,
      metadata: {
        dispute_id: disputeId,
        resolution,
        panel_resolution: majorityResolution,
        admin_override: overridingPanel,
        auto_enforced: !isAdmin && adminWindowExpired,
        arbiter_notes: arbiter_notes ?? null,
      },
    });

    if (overridingPanel) {
      await appendLedgerEntry({
        tradeId: trade.id,
        actorUserId: req.user.id,
        eventType: "dispute_admin_override",
        referenceTx: tx_signature,
        metadata: {
          dispute_id: disputeId,
          panel_resolution: majorityResolution,
          final_resolution: resolution,
          override_policy_code: overridePolicyCode,
          admin_override_reason: adminOverrideReason,
        },
      });
    } else if (!isAdmin && adminWindowExpired) {
      await appendLedgerEntry({
        tradeId: trade.id,
        actorUserId: req.user.id,
        eventType: "dispute_auto_enforced",
        referenceTx: tx_signature,
        metadata: {
          dispute_id: disputeId,
          final_resolution: resolution,
        },
      });
    }

    const ledgerRows = await prisma.ledgerEntry.findMany({
      where: { trade_id: trade.id },
      orderBy: { created_at: "asc" },
    });
    const receiptPayload = {
      trade_id: trade.id,
      trade_number: trade.trade_number,
      resolution,
      panel_resolution: majorityResolution,
      panel_size: dispute.panel_size,
      quorum_required: quorum,
      tx_signature,
      generated_at: new Date().toISOString(),
      panel_attestations: dispute.assignments.map((a) => ({
        arbiter_profile_id: a.arbiter_profile_id,
        arbiter_user_id: a.arbiter.user_id,
        accepted_at: a.accepted_at,
        voted_at: a.voted_at,
        vote: a.vote,
        vote_reason: a.vote_reason,
      })),
      ledger_entries: ledgerRows.map((r) => ({
        id: r.id,
        event_type: r.event_type,
        amount_usdc: r.amount_usdc,
        reference_tx: r.reference_tx,
        entry_hash: r.entry_hash,
        previous_hash: r.previous_hash,
        created_at: r.created_at,
      })),
    };
    const latestHash = computeReceiptHash(receiptPayload);
    const previousReceipt = await prisma.tradeReceipt.findUnique({
      where: { trade_id: trade.id },
    });
    await prisma.tradeReceipt.upsert({
      where: { trade_id: trade.id },
      create: {
        trade_id: trade.id,
        tx_signature,
        receipt_hash: latestHash,
        previous_receipt_hash: previousReceipt?.receipt_hash ?? null,
        receipt_payload: receiptPayload,
      },
      update: {
        tx_signature,
        receipt_hash: latestHash,
        previous_receipt_hash: previousReceipt?.receipt_hash ?? null,
        receipt_payload: receiptPayload,
      },
    });

    return NextResponse.json({
      success: true,
      resolution,
      overridden: overridingPanel,
      auto_enforced: !isAdmin && adminWindowExpired,
    });
  } catch (error) {
    return validationErrorResponse(error);
  }
});
