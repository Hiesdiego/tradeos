import { NextRequest, NextResponse } from "next/server";
import {
  autoEscalateOverdueProofTimeouts,
  getProofResponseSlaHours,
} from "@/lib/trade/proofEscalation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getCronLimit(req: NextRequest): number {
  const urlLimit = Number(req.nextUrl.searchParams.get("limit"));
  const envLimit = Number(process.env.PROOF_TIMEOUT_CRON_LIMIT ?? 50);
  const raw = Number.isFinite(urlLimit) && urlLimit > 0 ? urlLimit : envLimit;
  return Number.isFinite(raw) ? Math.max(1, Math.min(Math.round(raw), 200)) : 50;
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  const headerSecret = req.headers.get("x-cron-secret");

  return bearer === secret || headerSecret === secret;
}

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured" },
      { status: 500 }
    );
  }

  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const result = await autoEscalateOverdueProofTimeouts({ limit: getCronLimit(req) });

  return NextResponse.json({
    ok: true,
    sla_hours: getProofResponseSlaHours(),
    ...result,
  });
}
