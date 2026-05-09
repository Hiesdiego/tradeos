import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set.");
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePoolerMode(url: string): "supabase-session" | "other" {
  try {
    const parsed = new URL(url);
    const isSupabasePooler = parsed.hostname.includes(".pooler.supabase.com");
    const port = parsed.port || "5432";
    if (isSupabasePooler && port === "5432") {
      return "supabase-session";
    }
  } catch {
    // noop: keep default mode
  }
  return "other";
}

/**
 * FIX: P1017 "Server has closed the connection"
 *
 * The previous code passed `{ connectionString }` directly to PrismaPg,
 * which created a pool with no timeout config. Neon/Supabase closes idle
 * connections after ~5 minutes of inactivity. Without an idleTimeoutMillis,
 * the pool holds on to stale connections indefinitely — and the next query
 * blocks for 57 seconds waiting for a dead socket before Prisma gives up.
 *
 * The fix: create the pg.Pool explicitly with:
 *  - idleTimeoutMillis: recycle connections before the DB closes them
 *  - connectionTimeoutMillis: fail fast rather than hanging forever
 *  - max: reasonable cap for Next.js (many short-lived lambda-style requests)
 *
 * If you're on Neon, also make sure DATABASE_URL uses the POOLED endpoint
 * (the one with ?pgbouncer=true or the pooler subdomain), not the direct
 * connection string. Direct connections get killed by Neon frequently.
 */
function createPrismaClient() {
  const isVercelProd =
    process.env.VERCEL === "1" &&
    process.env.VERCEL_ENV === "production";
  const poolerMode = parsePoolerMode(connectionString!);
  const isSupabaseSessionMode = poolerMode === "supabase-session";
  const defaultPoolMax = isVercelProd
    ? isSupabaseSessionMode
      ? 1
      : 2
    : 10;
  const requestedPoolMax = readIntEnv("PG_POOL_MAX", defaultPoolMax);
  const poolMax =
    isVercelProd && isSupabaseSessionMode
      ? Math.min(requestedPoolMax, 1)
      : requestedPoolMax;
  const idleTimeoutMillis = readIntEnv("PG_IDLE_TIMEOUT_MS", 20_000);
  const connectionTimeoutMillis = readIntEnv("PG_CONNECT_TIMEOUT_MS", 8_000);

  if (isVercelProd && isSupabaseSessionMode) {
    console.warn(
      "[prisma] Using Supabase session-mode pooler (:5432) on Vercel production. " +
        "Clamping PG pool max to 1 to reduce EMAXCONNSESSION errors. " +
        "Recommended fix: switch DATABASE_URL to Supabase transaction mode (:6543)."
    );
  }

  const pool = new Pool({
    connectionString,
    // Keep prod pool small for serverless fan-out. Override via PG_POOL_MAX.
    max: poolMax,
    idleTimeoutMillis,       // recycle idle connections before provider closes them
    connectionTimeoutMillis, // fail fast if pool acquisition is saturated
    allowExitOnIdle: true,
  });

  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });
}

export const prisma =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
