import { NextRequest, NextResponse } from "next/server";
import {
  withAuth,
  type AuthedRequest,
} from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { safeJson, validationErrorResponse } from "@/lib/api/validation";
import { safeAuditLog } from "@/lib/audit/redaction";
import { computeCounterpartyRiskSignals } from "@/lib/risk";
import { buildCorridorGuidance } from "@/lib/corridorIntelligence";
import { autoEscalateProofTimeoutForTrade } from "@/lib/trade/proofEscalation";
import {
  PrivyClient,
  type LinkedAccount,
  type User as PrivyUser,
} from "@privy-io/node";

type Context = { params: { tradeId: string } };
type GetContext = { params: Promise<{ tradeId: string }> };

const privyAppId =
  process.env.PRIVY_APP_ID?.trim() ||
  process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
const privyAppSecret = process.env.PRIVY_APP_SECRET?.trim();
const isDevAuthLogging = process.env.NODE_ENV === "development";

if (!privyAppId || !privyAppSecret) {
  throw new Error("Privy app ID or secret not provided");
}

/**
 * Single PrivyClient instance — reused across requests.
 * JWT verification is local (no network). Creating this per-request is wasteful.
 */
const privy = new PrivyClient({
  appId: privyAppId!,
  appSecret: privyAppSecret!,
});

type PrivyLinkedAccount = LinkedAccount & {
  chain_type?: string;
  address?: string;
};

type PrivyEmailAccount = Extract<LinkedAccount, { type: "email" }>;

function extractIdentityToken(req: NextRequest): string | null {
  return (
    req.headers.get("x-privy-id-token")?.trim() ||
    req.headers.get("privy-id-token")?.trim() ||
    req.cookies.get("privy-id-token")?.value?.trim() ||
    null
  );
}

async function resolvePrivyUser(req: NextRequest, privyDid: string) {
  const identityToken = extractIdentityToken(req);
  if (identityToken) {
    try {
      const userFromIdentityToken = await privy.users().get({
        id_token: identityToken,
      });
      if (userFromIdentityToken.id === privyDid) {
        return {
          user: userFromIdentityToken,
          method: "identityToken" as const,
        };
      }
    } catch {
      // fall through to server lookup
    }
  }

  return {
    user: await privy.users()._get(privyDid),
    method: "privyUsersApi" as const,
  };
}

function getSolanaWalletAddress(privyUser: PrivyUser): string | undefined {
  const accounts = privyUser.linked_accounts as PrivyLinkedAccount[];

  // 1) Prefer standard embedded wallet
  const embedded = accounts.find(
    (a) => a.type === "wallet" && a.chain_type === "solana" && a.address
  );
  if (embedded?.address) return embedded.address;

  // 2) Fall back to AA wallet (type may be undefined)
  const aa = accounts.find(
    (a) =>
      a.chain_type === "solana" &&
      a.address != null &&
      a.address.length >= 32
  );
  return aa?.address;
}

function getEmailAddress(privyUser: PrivyUser): string | null {
  return (
    privyUser.linked_accounts.find(
      (account): account is PrivyEmailAccount => account.type === "email"
    )?.address ?? null
  );
}

async function resolveOptionalAuthWallet(req: NextRequest, token: string) {
  const decoded = (() => {
    try {
      const parts = token.split(".");
      if (parts.length < 2) return null;
      const payloadPart = parts[1];
      const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        "="
      );
      return JSON.parse(
        Buffer.from(padded, "base64").toString("utf8")
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

  try {
    const verifiedClaims = await privy
      .utils()
      .auth()
      .verifyAccessToken(token);
    const privyDid = verifiedClaims.user_id;
    const { user: privyUser, method: userLookupMethod } = await resolvePrivyUser(
      req,
      privyDid
    );
    return {
      privyDid,
      walletAddress: getSolanaWalletAddress(privyUser) ?? null,
      email: getEmailAddress(privyUser),
      verificationMethod: "verifyAccessToken" as const,
      userLookupMethod,
    };
  } catch {
    const verifiedAuthClaims = await privy
      .utils()
      .auth()
      .verifyAuthToken(token);
    const privyDid =
      verifiedAuthClaims.user_id ??
      (typeof decoded?.sub === "string" ? decoded.sub : undefined);
    if (!privyDid) {
      return {
        privyDid: undefined,
        walletAddress: null,
        email: null,
        verificationMethod: "verifyAuthToken" as const,
      };
    }
    const { user: privyUser, method: userLookupMethod } = await resolvePrivyUser(
      req,
      privyDid
    );
    return {
      privyDid,
      walletAddress: getSolanaWalletAddress(privyUser) ?? null,
      email: getEmailAddress(privyUser),
      verificationMethod: "verifyAuthToken" as const,
      userLookupMethod,
    };
  }
}

async function getOptionalAuthedUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  try {
    const token = authHeader.replace("Bearer ", "");
    const { privyDid, walletAddress, email, verificationMethod, userLookupMethod } =
      await resolveOptionalAuthWallet(req, token);

    if (!walletAddress) {
      if (isDevAuthLogging) safeAuditLog("warn", "[GET /api/trades/[tradeId]] optional auth missing wallet", {
        path: req.nextUrl.pathname,
        privyDid,
      });
      return null;
    }

    const user = await prisma.user.upsert({
      where: { wallet_address: walletAddress },
      create: { wallet_address: walletAddress, email },
      update: { email },
    });
    if (isDevAuthLogging) {
      safeAuditLog("log", "[GET /api/trades/[tradeId]] optional auth resolved", {
        privyDid,
        verificationMethod,
        userLookupMethod,
        walletAddress,
        userId: user.id,
      });
    }
    return user;
  } catch {
    return null;
  }
}

// GET /api/trades/[tradeId] — fetch a single trade with all relations
export async function GET(req: NextRequest, ctx: GetContext) {
  const { tradeId } = await ctx.params;
  const authedUser = await getOptionalAuthedUser(req);

  const includeGraph = {
    buyer: true,
    supplier: true,
    milestones: {
      orderBy: { milestone_number: "asc" as const },
      include: {
        proofs: { orderBy: { created_at: "desc" as const } },
        ai_checks: { orderBy: { created_at: "desc" as const }, take: 1 },
      },
    },
    disputes: {
      include: { raiser: true },
      orderBy: { created_at: "desc" as const },
    },
    receipt: true,
  };

  let trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: includeGraph,
  });

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  const isMember =
    authedUser !== null &&
    (trade.buyer_id === authedUser.id || trade.supplier_id === authedUser.id);

  if (!isMember) {
    const inviteToken = new URL(req.url).searchParams.get("invite_token");
    const isValidInviteView =
      trade.status === "pending_supplier" &&
      !!inviteToken &&
      inviteToken === trade.supplier_invite_token;

    if (!isValidInviteView) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (isMember) {
    const escalated = await autoEscalateProofTimeoutForTrade(tradeId);
    if (escalated > 0) {
      trade = await prisma.trade.findUnique({
        where: { id: tradeId },
        include: includeGraph,
      });
      if (!trade) {
        return NextResponse.json({ error: "Trade not found" }, { status: 404 });
      }
    }
  }

  const counterpartyId =
    authedUser && trade.buyer_id === authedUser.id
      ? trade.supplier_id
      : authedUser && trade.supplier_id === authedUser.id
      ? trade.buyer_id
      : null;

  let counterpartyRiskSignals: ReturnType<typeof computeCounterpartyRiskSignals> | null = null;
  if (counterpartyId && isMember) {
    const [counterpartyTrades, corridorTrades] = await Promise.all([
      prisma.trade.findMany({
        where: {
          OR: [{ buyer_id: counterpartyId }, { supplier_id: counterpartyId }],
        },
        include: {
          disputes: true,
          milestones: {
            select: { proof_uploaded_at: true, released_at: true },
          },
        },
      }),
      prisma.trade.findMany({
        where: { corridor: trade.corridor },
        include: {
          disputes: true,
          milestones: {
            select: { proof_uploaded_at: true, released_at: true },
          },
        },
        take: 300,
      }),
    ]);
    counterpartyRiskSignals = computeCounterpartyRiskSignals({
      counterpartyUserId: counterpartyId,
      corridor: trade.corridor,
      counterpartyTrades,
      corridorTrades,
    });
  }

  return NextResponse.json({
    ...trade,
    supplier_invite_link: trade.supplier_invite_token
      ? `${process.env.NEXT_PUBLIC_APP_URL}/trades/${trade.id}?invite_token=${trade.supplier_invite_token}`
      : null,
    counterparty_risk_signals: counterpartyRiskSignals,
    corridor_intelligence: buildCorridorGuidance({
      corridor: trade.corridor,
      commodityType: trade.goods_category,
    }),
  });
}

// PATCH /api/trades/[tradeId] — guarded updates only
export const PATCH = withAuth(async (req: AuthedRequest, ctx: Context) => {
  try {
    const { tradeId } = ctx.params;
    const body = await safeJson<Record<string, unknown>>(req);
    const status = typeof body.status === "string" ? body.status : undefined;
    const escrowPubkeyRequested = typeof body.escrow_pubkey === "string";
    const supplierIdRequested = typeof body.supplier_id === "string";

    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    }

    const isMember =
      trade.buyer_id === req.user.id || trade.supplier_id === req.user.id;
    if (!isMember) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (escrowPubkeyRequested || supplierIdRequested) {
      return NextResponse.json(
        {
          error:
            "Direct escrow/supplier updates are disabled. Use dedicated endpoints.",
        },
        { status: 400 }
      );
    }

    if (!status) {
      return NextResponse.json(
        { error: "No supported fields to update" },
        { status: 400 }
      );
    }

    if (status !== "cancelled") {
      return NextResponse.json(
        {
          error:
            "Status changes are restricted. Use dedicated trade action endpoints.",
        },
        { status: 400 }
      );
    }
    if (req.user.id !== trade.buyer_id) {
      return NextResponse.json(
        { error: "Only the buyer can cancel this trade" },
        { status: 403 }
      );
    }
    if (!["pending_supplier", "pending_funding"].includes(trade.status)) {
      return NextResponse.json(
        {
          error:
            "Only trades awaiting supplier/funding can be cancelled from this endpoint",
        },
        { status: 400 }
      );
    }

    const updated = await prisma.trade.update({
      where: { id: tradeId },
      data: { status: "cancelled" },
      include: {
        buyer: true,
        supplier: true,
        milestones: { orderBy: { milestone_number: "asc" } },
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    return validationErrorResponse(error);
  }
});

// DELETE /api/trades/[tradeId] - buyer can delete stale unclaimed orders after 24h
export const DELETE = withAuth(async (req: AuthedRequest, ctx: Context) => {
  const { tradeId } = ctx.params;
  const trade = await prisma.trade.findUnique({ where: { id: tradeId } });

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }
  if (trade.buyer_id !== req.user.id) {
    return NextResponse.json(
      { error: "Only the buyer can delete this trade" },
      { status: 403 }
    );
  }
  if (trade.supplier_id) {
    return NextResponse.json(
      { error: "Trade already has a supplier and cannot be deleted" },
      { status: 400 }
    );
  }
  if (trade.status !== "pending_supplier") {
    return NextResponse.json(
      { error: "Only pending supplier trades can be deleted" },
      { status: 400 }
    );
  }

  const ageMs = Date.now() - new Date(trade.created_at).getTime();
  const minAgeMs = 24 * 60 * 60 * 1000;
  if (ageMs < minAgeMs) {
    const remainingHours = Math.ceil((minAgeMs - ageMs) / (60 * 60 * 1000));
    return NextResponse.json(
      {
        error: `Trade can be deleted after 24 hours. Try again in about ${remainingHours} hour(s).`,
      },
      { status: 400 }
    );
  }

  await prisma.$transaction(
    [
      prisma.tradeMessage.deleteMany({ where: { trade_id: trade.id } }),
      prisma.dispute.deleteMany({ where: { trade_id: trade.id } }),
      prisma.milestone.deleteMany({ where: { trade_id: trade.id } }),
      prisma.reputationEvent.deleteMany({ where: { trade_id: trade.id } }),
      prisma.telegramTradeSubscription.deleteMany({ where: { trade_id: trade.id } }),
      prisma.tradeReceipt.deleteMany({ where: { trade_id: trade.id } }),
      prisma.ledgerEntry.deleteMany({ where: { trade_id: trade.id } }),
      prisma.trade.delete({ where: { id: trade.id } }),
    ],
    {
      maxWait: 15_000,
      timeout: 30_000,
    }
  );
  return NextResponse.json({ success: true });
});
