import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { canonicalTradeTermsString } from "@/lib/trade/terms";
import { createHash } from "node:crypto";
import { deriveEscrowPda } from "@/lib/solana/program";
import { fetchEscrowAccount } from "@/lib/solana/escrow";

type Context = { params: { tradeId: string } };

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object") {
    const maybe = value as { toNumber?: () => number; toString?: () => string };
    if (typeof maybe.toNumber === "function") {
      const n = maybe.toNumber();
      return Number.isFinite(n) ? n : null;
    }
    if (typeof maybe.toString === "function") {
      const n = Number(maybe.toString());
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function statusFromReleasedCount(releasedCount: number, totalMilestones: number) {
  if (releasedCount >= totalMilestones && totalMilestones > 0) return "completed";
  if (releasedCount <= 0) return null;
  if (releasedCount === 1) return "milestone_1_released";
  if (releasedCount === 2) return "milestone_2_released";
  return "in_progress";
}

export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  const { tradeId } = ctx.params;

  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: {
      buyer: true,
      supplier: true,
      milestones: { orderBy: { milestone_number: "asc" } },
    },
  });
  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }
  if (trade.buyer_id !== req.user.id && trade.supplier_id !== req.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  const onChainEscrow = (await fetchEscrowAccount(tradeTermsHash)) as
    | Record<string, unknown>
    | null;
  if (!onChainEscrow) {
    return NextResponse.json(
      { error: "Escrow account not found on-chain for this trade." },
      { status: 404 }
    );
  }

  const onChainCurrentMilestoneRaw =
    onChainEscrow.current_milestone ?? onChainEscrow.currentMilestone;
  const onChainCurrentMilestone = toNumber(onChainCurrentMilestoneRaw);
  if (onChainCurrentMilestone == null || onChainCurrentMilestone < 0) {
    return NextResponse.json(
      { error: "Unable to read on-chain milestone progress." },
      { status: 502 }
    );
  }

  const totalMilestones = trade.milestones.length;
  const releasedCount = Math.min(onChainCurrentMilestone, totalMilestones);
  const nextMilestoneNumber =
    releasedCount < totalMilestones ? releasedCount + 1 : null;
  const now = new Date();
  const nextTradeStatus = statusFromReleasedCount(releasedCount, totalMilestones);

  await prisma.$transaction(async (tx) => {
    if (releasedCount > 0) {
      await tx.milestone.updateMany({
        where: {
          trade_id: tradeId,
          milestone_number: { lte: releasedCount },
          status: { not: "released" },
        },
        data: {
          status: "released",
          released_at: now,
        },
      });
    }

    const tradeData: { escrow_pubkey?: string; status?: typeof trade.status } = {};
    if (!trade.escrow_pubkey) {
      tradeData.escrow_pubkey = expectedEscrowPda.toBase58();
    }
    if (nextTradeStatus) {
      tradeData.status = nextTradeStatus;
    }
    if (Object.keys(tradeData).length > 0) {
      await tx.trade.update({
        where: { id: tradeId },
        data: tradeData,
      });
    }
  });

  return NextResponse.json({
    synced: true,
    released_count: releasedCount,
    next_milestone_number: nextMilestoneNumber,
  });
});
