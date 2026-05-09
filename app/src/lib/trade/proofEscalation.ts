import { prisma } from "@/lib/db/prisma";
import { appendLedgerEntry } from "@/lib/ledger";
import { notifyDisputeRaised } from "@/lib/telegram/notifications";
import {
  computeArbitrationFeeUsdc,
  computeSlaDeadlines,
  DEFAULT_PANEL_SIZE,
  getAdminOverrideDeadline,
} from "@/lib/arbitration.shared";
import type { Trade } from "@/types";

const MIN_SLA_HOURS = 120;
const MAX_SLA_HOURS = 168;
const DEFAULT_SLA_HOURS = 144;
const OPEN_DISPUTE_STATUSES = new Set([
  "open",
  "under_review",
  "escalated",
  "pending_admin_review",
]);

export function getProofResponseSlaHours(): number {
  const raw = Number(process.env.PROOF_RESPONSE_SLA_HOURS ?? DEFAULT_SLA_HOURS);
  if (!Number.isFinite(raw)) return DEFAULT_SLA_HOURS;
  return Math.max(MIN_SLA_HOURS, Math.min(MAX_SLA_HOURS, Math.round(raw)));
}

export async function autoEscalateOverdueProofTimeouts(input: { limit?: number } = {}): Promise<{
  scannedTrades: number;
  escalatedDisputes: number;
  tradeIds: string[];
}> {
  const slaHours = getProofResponseSlaHours();
  const cutoff = new Date(Date.now() - slaHours * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(Math.round(input.limit ?? 50), 200));

  const overdueMilestones = await prisma.milestone.findMany({
    where: {
      status: "proof_uploaded",
      proof_uploaded_at: { lte: cutoff },
      trade: {
        status: {
          in: ["funded", "in_progress", "milestone_1_released", "milestone_2_released"],
        },
      },
    },
    select: { trade_id: true },
    orderBy: { proof_uploaded_at: "asc" },
    take: limit,
  });

  const tradeIds = [...new Set(overdueMilestones.map((milestone) => milestone.trade_id))];
  let escalatedDisputes = 0;

  for (const tradeId of tradeIds) {
    escalatedDisputes += await autoEscalateProofTimeoutForTrade(tradeId);
  }

  return {
    scannedTrades: tradeIds.length,
    escalatedDisputes,
    tradeIds,
  };
}

export async function autoEscalateProofTimeoutForTrade(tradeId: string): Promise<number> {
  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: {
      buyer: true,
      supplier: true,
      milestones: { orderBy: { milestone_number: "asc" } },
      disputes: { orderBy: { created_at: "desc" } },
    },
  });
  if (!trade) return 0;
  if (["completed", "cancelled", "refunded", "disputed"].includes(trade.status)) return 0;

  const now = new Date();
  const slaHours = getProofResponseSlaHours();
  const panelSize = DEFAULT_PANEL_SIZE;
  const signupHoursRaw = Number(process.env.ARBITRATION_PANEL_SIGNUP_HOURS ?? 24);
  const signupHours = Number.isFinite(signupHoursRaw) ? Math.max(1, Math.round(signupHoursRaw)) : 24;

  let escalatedCount = 0;

  for (const milestone of trade.milestones) {
    if (milestone.status !== "proof_uploaded" || !milestone.proof_uploaded_at) continue;

    const deadline = new Date(milestone.proof_uploaded_at.getTime() + slaHours * 60 * 60 * 1000);
    if (now < deadline) continue;

    const hasOpenDispute = trade.disputes.some(
      (d) => d.milestone_id === milestone.id && OPEN_DISPUTE_STATUSES.has(d.status)
    );
    if (hasOpenDispute) continue;

    const milestoneAmountUsdc = Number(milestone.release_amount_usdc ?? trade.total_amount_usdc);
    const arbitrationFeeUsdc = computeArbitrationFeeUsdc(milestoneAmountUsdc);
    const feeRateBps =
      milestoneAmountUsdc > 0
        ? Math.round((arbitrationFeeUsdc * 10_000) / milestoneAmountUsdc)
        : 0;
    const { evidenceDeadline, decisionDeadline } = computeSlaDeadlines(now);
    const adminOverrideDeadline = getAdminOverrideDeadline(now);
    const panelSignupDeadline = new Date(now.getTime() + signupHours * 60 * 60 * 1000);
    const reason = `Auto-escalated after ${slaHours}h: buyer did not act on Milestone ${milestone.milestone_number} proof submission.`;

    const dispute = await prisma.$transaction(async (tx) => {
      const created = await tx.dispute.create({
        data: {
          trade_id: trade.id,
          milestone_id: milestone.id,
          raised_by: trade.supplier_id ?? trade.buyer_id,
          reason,
          status: "open",
          arbiter_notes: "auto_escalation:proof_timeout",
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
        where: { id: trade.id },
        data: {
          status: "disputed",
          arbitration_fee_reserve_usdc: { increment: arbitrationFeeUsdc },
          arbitration_fee_rate_bps: feeRateBps,
        },
      });

      await tx.milestone.update({
        where: { id: milestone.id },
        data: { status: "disputed" },
      });

      return created;
    });

    await appendLedgerEntry({
      tradeId: trade.id,
      actorUserId: trade.supplier_id ?? trade.buyer_id,
      eventType: "dispute_opened",
      metadata: {
        dispute_id: dispute.id,
        milestone_number: milestone.milestone_number,
        reason,
        auto_escalated: true,
        proof_uploaded_at: milestone.proof_uploaded_at.toISOString(),
        response_sla_hours: slaHours,
      },
    });

    await appendLedgerEntry({
      tradeId: trade.id,
      actorUserId: trade.supplier_id ?? trade.buyer_id,
      eventType: "arbitration_fee_charged",
      amountUsdc: arbitrationFeeUsdc,
      metadata: {
        dispute_id: dispute.id,
        panel_size: panelSize,
        fee_rate_bps: feeRateBps,
        fee_source: "reserve",
        auto_escalated: true,
      },
    });

    await notifyDisputeRaised(
      trade.buyer_id,
      trade.buyer?.telegram_chat_id,
      trade.supplier_id,
      trade.supplier?.telegram_chat_id,
      process.env.ARBITER_TELEGRAM_CHAT_ID,
      trade as unknown as Trade,
      "supplier",
      reason
    );

    escalatedCount += 1;
  }

  return escalatedCount;
}
