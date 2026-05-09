import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export async function GET() {
  const authConfig = {
    hasPrivyAppId: Boolean(
      process.env.PRIVY_APP_ID?.trim() || process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim()
    ),
    hasPrivyAppSecret: Boolean(process.env.PRIVY_APP_SECRET?.trim()),
  };

  let dbOk = false;
  let dbError: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (error) {
    dbError = error instanceof Error ? error.message : "DB check failed";
  }

  const ok = dbOk && authConfig.hasPrivyAppId && authConfig.hasPrivyAppSecret;
  return NextResponse.json(
    {
      ok,
      timestamp: new Date().toISOString(),
      checks: {
        db: dbOk,
        authConfig,
      },
      ...(dbError ? { dbError } : {}),
    },
    { status: ok ? 200 : 503 }
  );
}
