export function redactTokenLike(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const looksJwt = trimmed.split(".").length === 3 && trimmed.length > 24;
    const looksLongSecret = /^[A-Za-z0-9_\-.+/=]{24,}$/.test(trimmed);
    if (looksJwt || looksLongSecret) {
      return "[REDACTED]";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactTokenLike(entry));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("authorization") ||
        lower.includes("cookie") ||
        lower.includes("password") ||
        lower.includes("bearer")
      ) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = redactTokenLike(entry);
    }
    return out;
  }

  return value;
}

export function safeAuditLog(
  level: "log" | "warn" | "error",
  message: string,
  payload?: unknown
) {
  if (payload === undefined) {
    console[level](message);
    return;
  }
  console[level](message, redactTokenLike(payload));
}
