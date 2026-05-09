import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import {
  asNonEmptyString,
  safeJson,
  validationErrorResponse,
} from "@/lib/api/validation";
import { assertEscrowFundingTx } from "@/lib/solana/verify";
import { USDC_FACTOR, USDC_MINT } from "@/lib/constants";
import { appendLedgerEntry } from "@/lib/ledger";
import { createHash } from "node:crypto";
import { canonicalTradeTermsString } from "@/lib/trade/terms";
import { deriveEscrowPda } from "@/lib/solana/program";
import { computeCounterpartyRiskSignals } from "@/lib/risk";
import {
  readIdempotencyKey,
  readIdempotencyMetaValue,
} from "@/lib/api/idempotency";

type Context = { params: { tradeId: string } };

// POST /api/trades/[tradeId]/fund
// Called AFTER the on-chain fund_escrow tx is confirmed
// Records the escrow pubkey and flips trade status to funded
export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  try {
    const { tradeId } = ctx.params;
    const idempotencyKey = readIdempotencyKey(req.headers);
    const body = await safeJson<Record<string, unknown>>(req);
    const escrow_pubkey = asNonEmptyString(body.escrow_pubkey, "escrow_pubkey");
    const tx_signature = asNonEmptyString(body.tx_signature, "tx_signature");

    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      include: { buyer: true, supplier: true, milestones: true },
    });
    if (!trade) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    }

    if (trade.buyer_id !== req.user.id) {
      return NextResponse.json(
        { error: "Only the buyer can fund" },
        { status: 403 }
      );
    }

    if (trade.status !== "pending_funding") {
      if (trade.status === "funded" && trade.escrow_pubkey === escrow_pubkey) {
        return NextResponse.json(trade);
      }
      return NextResponse.json(
        { error: "Trade is not awaiting funding" },
        { status: 400 }
      );
    }
    if (trade.escrow_pubkey && trade.escrow_pubkey !== escrow_pubkey) {
      return NextResponse.json(
        { error: "Escrow pubkey does not match existing trade escrow" },
        { status: 409 }
      );
    }
    const canonicalTerms = canonicalTradeTermsString({
      trade_number: trade.trade_number,
      buyer_wallet_address: trade.buyer.wallet_address,
      supplier_wallet_address: trade.supplier?.wallet_address ?? null,
      goods_description: trade.goods_description,
      goods_category: trade.goods_category,
      quantity: trade.quantity,
      total_amount_usdc: String(trade.total_amount_usdc),
      corridor: trade.corridor,
      pickup_location: trade.pickup_location,
      dropoff_location: trade.dropoff_location,
      buyer_contact_name: trade.buyer_contact_name,
      buyer_contact_phone: trade.buyer_contact_phone,
      supplier_contact_name: trade.supplier_contact_name,
      supplier_contact_phone: trade.supplier_contact_phone,
      expected_ship_date: trade.expected_ship_date,
      expected_delivery_date: trade.expected_delivery_date,
      shipping_reference: trade.shipping_reference,
      incoterm: trade.incoterm,
      notes: trade.notes,
      milestones: (trade as { milestones?: Array<{ milestone_number: number; description: string; release_percentage: number }> }).milestones?.map((m) => ({
        milestone_number: m.milestone_number,
        description: m.description,
        release_percentage: m.release_percentage,
      })) ?? [],
    });
    const tradeTermsHash = createHash("sha256").update(canonicalTerms).digest("hex");
    const [expectedEscrowPda] = deriveEscrowPda(tradeTermsHash);
    if (expectedEscrowPda.toBase58() !== escrow_pubkey) {
      return NextResponse.json(
        { error: "Escrow pubkey does not match canonical trade terms anchor" },
        { status: 409 }
      );
    }
    if (idempotencyKey) {
      const existingEntry = await prisma.ledgerEntry.findFirst({
        where: { trade_id: tradeId, event_type: "escrow_funded" },
        orderBy: { created_at: "desc" },
      });
      if (
        readIdempotencyMetaValue(existingEntry?.metadata) === idempotencyKey &&
        trade.escrow_pubkey === escrow_pubkey
      ) {
        const alreadyFunded = await prisma.trade.findUnique({
          where: { id: tradeId },
          include: {
            buyer: true,
            supplier: true,
            milestones: { orderBy: { milestone_number: "asc" } },
          },
        });
        if (alreadyFunded) return NextResponse.json(alreadyFunded);
      }
    }

    const expectedAmountAtoms = BigInt(
      Math.round(Number(trade.total_amount_usdc) * USDC_FACTOR)
    );

    await assertEscrowFundingTx({
      txSignature: tx_signature,
      buyerWalletAddress: trade.buyer.wallet_address,
      escrowPubkey: escrow_pubkey,
      usdcMint: USDC_MINT,
      expectedAmountAtoms,
    });

    const counterpartyId = trade.supplier_id;
    let fundingRiskSnapshot: ReturnType<typeof computeCounterpartyRiskSignals> | null = null;
    if (counterpartyId) {
      const [counterpartyTrades, corridorTrades] = await Promise.all([
        prisma.trade.findMany({
          where: { OR: [{ buyer_id: counterpartyId }, { supplier_id: counterpartyId }] },
          include: {
            disputes: true,
            milestones: { select: { proof_uploaded_at: true, released_at: true } },
          },
        }),
        prisma.trade.findMany({
          where: { corridor: trade.corridor },
          include: {
            disputes: true,
            milestones: { select: { proof_uploaded_at: true, released_at: true } },
          },
          take: 300,
        }),
      ]);
      fundingRiskSnapshot = computeCounterpartyRiskSignals({
        counterpartyUserId: counterpartyId,
        corridor: trade.corridor,
        counterpartyTrades,
        corridorTrades,
      });
    }

    const updated = await prisma.trade.update({
      where: { id: tradeId },
      data: {
        escrow_pubkey,
        status: "funded",
      },
      include: {
        buyer: true,
        supplier: true,
        milestones: { orderBy: { milestone_number: "asc" } },
      },
    });

    await appendLedgerEntry({
      tradeId,
      actorUserId: req.user.id,
      eventType: "escrow_funded",
      amountUsdc: Number(trade.total_amount_usdc),
      referenceTx: tx_signature,
      metadata: {
        escrow_pubkey,
        idempotency_key: idempotencyKey,
        funding_risk_snapshot: fundingRiskSnapshot,
      },
    });

    return NextResponse.json({
      ...updated,
      funding_risk_snapshot: fundingRiskSnapshot,
    });
  } catch (error) {
    return validationErrorResponse(error);
  }
});
