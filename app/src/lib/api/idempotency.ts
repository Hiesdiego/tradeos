import type { Prisma } from "@prisma/client";

export function readIdempotencyKey(headers: Headers): string | null {
  const key = headers.get("idempotency-key")?.trim();
  if (!key) return null;
  return key.slice(0, 128);
}

export function readIdempotencyMetaValue(metadata: Prisma.JsonValue | null | undefined): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).idempotency_key;
  return typeof value === "string" ? value : null;
}
