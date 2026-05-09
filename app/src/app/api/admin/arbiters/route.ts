import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { isAdminWallet } from "@/lib/constants";
import {
  asNonEmptyString,
  asPositiveNumber,
  safeJson,
  validationErrorResponse,
} from "@/lib/api/validation";

export const GET = withAuth(async (req: AuthedRequest) => {
  if (!isAdminWallet(req.walletAddress)) {
    return NextResponse.json({ error: "Only admin wallets can view arbiters" }, { status: 403 });
  }

  const arbiters = await prisma.arbiterProfile.findMany({
    include: { user: true },
    orderBy: [{ active: "desc" }, { reputation_score: "desc" }, { stake_usdc: "desc" }],
  });
  return NextResponse.json(arbiters);
});

export const POST = withAuth(async (req: AuthedRequest) => {
  try {
    if (!isAdminWallet(req.walletAddress)) {
      return NextResponse.json({ error: "Only admin wallets can create arbiters" }, { status: 403 });
    }
    const body = await safeJson<Record<string, unknown>>(req);
    const walletAddress = asNonEmptyString(body.wallet_address, "wallet_address");
    const stakeUsdc = asPositiveNumber(body.stake_usdc, "stake_usdc");
    const reputationScore = typeof body.reputation_score === "number" ? body.reputation_score : 5;
    const minCase = typeof body.min_case_amount_usdc === "number" ? body.min_case_amount_usdc : 0;
    const maxCase = typeof body.max_case_amount_usdc === "number" ? body.max_case_amount_usdc : null;

    const user = await prisma.user.findUnique({ where: { wallet_address: walletAddress } });
    if (!user) {
      return NextResponse.json({ error: "User not found for wallet_address" }, { status: 404 });
    }

    const profile = await prisma.arbiterProfile.upsert({
      where: { user_id: user.id },
      create: {
        user_id: user.id,
        stake_usdc: stakeUsdc,
        reputation_score: reputationScore,
        min_case_amount_usdc: minCase,
        max_case_amount_usdc: maxCase,
      },
      update: {
        stake_usdc: stakeUsdc,
        reputation_score: reputationScore,
        min_case_amount_usdc: minCase,
        max_case_amount_usdc: maxCase,
        active: true,
      },
      include: { user: true },
    });

    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    return validationErrorResponse(error);
  }
});
