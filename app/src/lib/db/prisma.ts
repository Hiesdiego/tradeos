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
  const defaultPoolMax = isVercelProd ? 2 : 10;
  const poolMax = readIntEnv("PG_POOL_MAX", defaultPoolMax);
  const idleTimeoutMillis = readIntEnv("PG_IDLE_TIMEOUT_MS", 20_000);
  const connectionTimeoutMillis = readIntEnv("PG_CONNECT_TIMEOUT_MS", 8_000);

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
