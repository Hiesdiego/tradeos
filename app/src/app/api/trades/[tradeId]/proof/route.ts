import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { appendLedgerEntry } from "@/lib/ledger";

type Context = { params: { tradeId: string } };

// POST /api/trades/[tradeId]/proof — supplier uploads shipping proof for a milestone
export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  const { tradeId } = ctx.params;
  const body = await req.json();
  const { milestone_number, proof_url, proof_hash_sha256, proof_anchor_tx, proof_files } = body;

  if (!milestone_number) {
    return NextResponse.json(
      { error: "milestone_number is required" },
      { status: 400 }
    );
  }
  const normalizedProofFiles = Array.isArray(proof_files)
    ? proof_files
    : proof_url && proof_hash_sha256
    ? [
        {
          url: proof_url,
          hash_sha256: proof_hash_sha256,
          anchor_tx: proof_anchor_tx ?? null,
          mime: null,
        },
      ]
    : [];
  if (normalizedProofFiles.length === 0) {
    return NextResponse.json(
      { error: "Provide proof_files[] or proof_url + proof_hash_sha256" },
      { status: 400 }
    );
  }
  for (const [idx, proof] of normalizedProofFiles.entries()) {
    const url = typeof proof?.url === "string" ? proof.url : "";
    const hash = typeof proof?.hash_sha256 === "string" ? proof.hash_sha256 : "";
    if (!url || !hash) {
      return NextResponse.json(
        { error: `proof_files[${idx}] must include url and hash_sha256` },
        { status: 400 }
      );
    }
    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      return NextResponse.json(
        { error: `proof_files[${idx}].hash_sha256 must be valid SHA-256` },
        { status: 400 }
      );
    }
  }

  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: { milestones: true },
  });

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  if (trade.supplier_id !== req.user.id) {
    return NextResponse.json(
      { error: "Only the supplier can upload proof" },
      { status: 403 }
    );
  }

  if (!["funded", "in_progress", "milestone_1_released", "milestone_2_released"].includes(trade.status)) {
    return NextResponse.json(
      { error: "Trade is not in a state that accepts proof" },
      { status: 400 }
    );
  }

  const milestone = await prisma.milestone.findUnique({
    where: {
      trade_id_milestone_number: {
        trade_id: tradeId,
        milestone_number: Number(milestone_number),
      },
    },
  });

  if (!milestone) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  const orderedMilestones = [...trade.milestones].sort(
    (a, b) => a.milestone_number - b.milestone_number
  );
  const nextActionable = orderedMilestones.find((m) => m.status !== "released");
  if (!nextActionable) {
    return NextResponse.json(
      { error: "All milestones are already released" },
      { status: 400 }
    );
  }

  if (nextActionable.milestone_number !== Number(milestone_number)) {
    return NextResponse.json(
      {
        error: `You can only upload proof for milestone ${nextActionable.milestone_number} right now.`,
      },
      { status: 400 }
    );
  }

  if (nextActionable.status === "proof_uploaded") {
    return NextResponse.json(
      {
        error:
          "Current milestone proof is already uploaded and awaiting buyer action.",
      },
      { status: 400 }
    );
  }

  if (milestone.status === "released") {
    return NextResponse.json(
      { error: "This milestone has already been released" },
      { status: 400 }
    );
  }

  const firstProof = normalizedProofFiles[0];
  const updated = await prisma.milestone.update({
    where: { id: milestone.id },
    data: {
      proof_url: firstProof.url,
      proof_hash_sha256: firstProof.hash_sha256,
      proof_anchor_tx: firstProof.anchor_tx ?? null,
      proof_rejection_reason: null,
      proof_rejected_at: null,
      proof_version: { increment: 1 },
      proof_uploaded_at: new Date(),
      status: "proof_uploaded",
      proofs: {
        create: normalizedProofFiles.map((p) => ({
          uploader_user_id: req.user.id,
          file_url: p.url,
          file_mime: typeof p.mime === "string" ? p.mime : null,
          file_hash_sha256: p.hash_sha256,
          file_anchor_tx: typeof p.anchor_tx === "string" ? p.anchor_tx : null,
        })),
      },
    },
    include: { proofs: { orderBy: { created_at: "desc" } } },
  });

  await appendLedgerEntry({
    tradeId,
    actorUserId: req.user.id,
    eventType: "proof_uploaded",
    amountUsdc: Number(milestone.release_amount_usdc ?? 0),
    referenceTx: proof_anchor_tx ?? null,
    metadata: {
      milestone_number: Number(milestone_number),
      proof_files: normalizedProofFiles,
      proof_version: updated.proof_version,
    },
  });

  return NextResponse.json(updated);
});
