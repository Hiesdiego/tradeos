import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import {
  asNonEmptyString,
  asPositiveInt,
  safeJson,
  validationErrorResponse,
} from "@/lib/api/validation";
import { assertChainBackedTx } from "@/lib/solana/verify";
import { appendLedgerEntry } from "@/lib/ledger";
import { createHash } from "node:crypto";
import { canonicalTradeTermsString } from "@/lib/trade/terms";
import { deriveEscrowPda } from "@/lib/solana/program";
import {
  readIdempotencyKey,
  readIdempotencyMetaValue,
} from "@/lib/api/idempotency";

type Context = { params: { tradeId: string } };

// POST /api/trades/[tradeId]/release
// Called AFTER the on-chain release_milestone tx is confirmed
// Updates milestone status and trade status in DB
export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  try {
    const { tradeId } = ctx.params;
    const idempotencyKey = readIdempotencyKey(req.headers);
    const body = await safeJson<Record<string, unknown>>(req);
    const milestone_number = asPositiveInt(
      body.milestone_number,
      "milestone_number"
    );
    const tx_signature = asNonEmptyString(body.tx_signature, "tx_signature");
    await assertChainBackedTx(tx_signature);

    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      include: {
        milestones: { orderBy: { milestone_number: "asc" } },
        buyer: true,
        supplier: true,
      },
    });

    if (!trade) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
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
      milestones: trade.milestones.map((m) => ({
        milestone_number: m.milestone_number,
        description: m.description,
        release_percentage: m.release_percentage,
      })),
    });
    const tradeTermsHash = createHash("sha256").update(canonicalTerms).digest("hex");
    const [expectedEscrowPda] = deriveEscrowPda(tradeTermsHash);
    if (trade.escrow_pubkey && trade.escrow_pubkey !== expectedEscrowPda.toBase58()) {
      return NextResponse.json(
        { error: "Trade escrow anchor does not match canonical trade terms" },
        { status: 409 }
      );
    }

    // Only buyer can confirm releases (contract authorization model)
    const isBuyer = trade.buyer_id === req.user.id;

    if (!isBuyer) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const milestone = trade.milestones.find(
      (m) => m.milestone_number === milestone_number
    );
    if (!milestone) {
      return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
    }
    if (milestone.status === "released") {
      if (!milestone.tx_signature || milestone.tx_signature === tx_signature) {
        return NextResponse.json(trade);
      }
      return NextResponse.json(
        { error: "Milestone already released" },
        { status: 409 }
      );
    }
    if (milestone.status !== "proof_uploaded") {
      return NextResponse.json(
        { error: "Milestone proof must be uploaded before release" },
        { status: 400 }
      );
    }
    if (idempotencyKey) {
      const existingEntry = await prisma.ledgerEntry.findFirst({
        where: { trade_id: tradeId, event_type: "milestone_released" },
        orderBy: { created_at: "desc" },
      });
      if (readIdempotencyMetaValue(existingEntry?.metadata) === idempotencyKey) {
        return NextResponse.json(trade);
      }
    }

    await prisma.milestone.update({
      where: {
        trade_id_milestone_number: {
          trade_id: tradeId,
          milestone_number,
        },
      },
      data: {
        status: "released",
        released_at: new Date(),
        tx_signature,
      },
    });

    // Determine new trade status
    const totalMilestones = trade.milestones.length;
    const newStatus =
      milestone_number === totalMilestones
        ? "completed"
        : milestone_number === 1
          ? "milestone_1_released"
          : milestone_number === 2
            ? "milestone_2_released"
            : "in_progress";

    const updatedTrade = await prisma.trade.update({
      where: { id: tradeId },
      data: { status: newStatus },
      include: {
        buyer: true,
        supplier: true,
        milestones: { orderBy: { milestone_number: "asc" } },
      },
    });

    const releasedAmount =
      (Number(trade.total_amount_usdc) * milestone.release_percentage) / 100;
    await appendLedgerEntry({
      tradeId,
      actorUserId: req.user.id,
      eventType: "milestone_released",
      amountUsdc: releasedAmount,
      referenceTx: tx_signature,
      metadata: {
        milestone_number,
        release_percentage: milestone.release_percentage,
        idempotency_key: idempotencyKey,
      },
    });

    // If completed — update reputation and trade counts
    if (newStatus === "completed" && trade.supplier_id) {
      await Promise.all([
        prisma.user.update({
          where: { id: trade.buyer_id },
          data: { completed_trades: { increment: 1 } },
        }),
        prisma.user.update({
          where: { id: trade.supplier_id },
          data: { completed_trades: { increment: 1 } },
        }),
        prisma.reputationEvent.createMany({
          data: [
            {
              user_id: trade.buyer_id,
              trade_id: tradeId,
              event_type: "trade_completed",
              score_delta: 0.1,
            },
            {
              user_id: trade.supplier_id,
              trade_id: tradeId,
              event_type: "trade_completed",
              score_delta: 0.1,
            },
          ],
        }),
        prisma.tradeReceipt.upsert({
          where: { trade_id: tradeId },
          create: { trade_id: tradeId, tx_signature },
          update: { tx_signature },
        }),
      ]);
    }

    return NextResponse.json(updatedTrade);
  } catch (error) {
    return validationErrorResponse(error);
  }
});
