import { NextRequest, NextResponse } from "next/server";
import {
  APIError,
  PrivyClient,
  type LinkedAccount,
  type User as PrivyUser,
} from "@privy-io/node";
import {
  createRemoteJWKSet,
  importJWK,
  importSPKI,
  jwtVerify,
} from "jose";
import { prisma } from "@/lib/db/prisma";
import { safeAuditLog } from "@/lib/audit/redaction";
import type { User } from "@prisma/client";

const appId =
  process.env.PRIVY_APP_ID?.trim() ||
  process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ||
  "";
const appSecret = process.env.PRIVY_APP_SECRET?.trim() || "";

const privy = new PrivyClient({
  appId,
  appSecret,
});

const jwksEndpoint =
  process.env.JWKS_ENDPOINT?.trim() ||
  (appId ? `https://auth.privy.io/api/v1/apps/${appId}/jwks.json` : null);
const jwks = jwksEndpoint ? createRemoteJWKSet(new URL(jwksEndpoint)) : null;
const localVerificationKey = process.env.PRIVY_VERIFICATION_KEY?.trim();

const isDevAuthLogging = process.env.NODE_ENV === "development";

let localKeyPromise: Promise<unknown | null> | null = null;
let localKeyInitError: string | null = null;
let localKeySource:
  | "jwk"
  | "pem"
  | "base64Der"
  | "unknown"
  | "missing" = localVerificationKey ? "unknown" : "missing";

function looksLikeBase64DerPublicKey(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  return (
    normalized.length >= 64 &&
    normalized.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+=*$/.test(normalized)
  );
}

function base64DerToPem(base64Der: string): string {
  const normalized = base64Der.replace(/\s+/g, "");
  const wrapped = normalized.match(/.{1,64}/g)?.join("\n") ?? normalized;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

async function getLocalVerificationKey(): Promise<unknown | null> {
  if (!localVerificationKey) return null;

  if (!localKeyPromise) {
    localKeyPromise = (async () => {
      try {
        if (localVerificationKey.startsWith("{")) {
          localKeySource = "jwk";
          const jwk = JSON.parse(localVerificationKey) as Record<
            string,
            unknown
          >;
          return await importJWK(jwk, "ES256");
        }

        if (localVerificationKey.includes("BEGIN PUBLIC KEY")) {
          localKeySource = "pem";
          return await importSPKI(localVerificationKey, "ES256");
        }

        if (looksLikeBase64DerPublicKey(localVerificationKey)) {
          localKeySource = "base64Der";
          return await importSPKI(base64DerToPem(localVerificationKey), "ES256");
        }

        localKeySource = "unknown";
        localKeyInitError =
          "Unsupported key format (expected JWK JSON, PEM, or base64 DER public key)";
        return null;
      } catch (error: unknown) {
        localKeyInitError =
          getErrorMessage(error) ?? "Failed to parse/import local verification key";
        return null;
      }
    })();
  }

  return localKeyPromise;
}

function extractIdentityToken(req: NextRequest): {
  token: string | null;
  source: "header" | "cookie" | "none";
} {
  const headerToken =
    req.headers.get("x-privy-id-token")?.trim() ||
    req.headers.get("privy-id-token")?.trim();
  if (headerToken) {
    return { token: headerToken, source: "header" };
  }

  const cookieToken = req.cookies.get("privy-id-token")?.value?.trim();
  if (cookieToken) {
    return { token: cookieToken, source: "cookie" };
  }

  return { token: null, source: "none" };
}

function getStatusCode(error: unknown): number | undefined {
  if (error instanceof APIError) return error.status;
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

// Standard embedded wallet account type
type PrivyEmailAccount = Extract<LinkedAccount, { type: "email" }>;

// AA wallets do not have a `type` field - they only have chain_type + address
type PrivyAAAccount = LinkedAccount & {
  chain_type?: string;
  address?: string;
};

function getSolanaWalletAddress(privyUser: PrivyUser): string | undefined {
  const accounts = privyUser.linked_accounts as PrivyAAAccount[];

  const embedded = accounts.find(
    (a) => a.type === "wallet" && a.chain_type === "solana" && a.address
  );
  if (embedded?.address) return embedded.address;

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

export type AuthedRequest = NextRequest & {
  user: User;
  walletAddress: string;
};

type RouteParams = Record<string, string>;

type RouteHandler<TParams extends RouteParams = Record<string, never>> = (
  req: AuthedRequest,
  context: { params: TParams }
) => Promise<Response>;

async function resolvePrivyUser(
  req: NextRequest,
  privyDid: string
): Promise<{
  privyUser: PrivyUser;
  source: "identityToken" | "privyUsersApi";
  identityTokenSource: "header" | "cookie" | "none";
}> {
  const { token: identityToken, source: identityTokenSource } =
    extractIdentityToken(req);

  if (identityToken) {
    try {
      const userFromIdentityToken = await privy.users().get({
        id_token: identityToken,
      });

      if (userFromIdentityToken.id !== privyDid) {
        if (isDevAuthLogging) safeAuditLog("warn", "[withAuth] Identity token subject mismatch", {
          path: req.nextUrl.pathname,
          expectedPrivyDid: privyDid,
          identityTokenPrivyDid: userFromIdentityToken.id,
          identityTokenSource,
        });
      } else {
        return {
          privyUser: userFromIdentityToken,
          source: "identityToken",
          identityTokenSource,
        };
      }
    } catch (error: unknown) {
      if (isDevAuthLogging) safeAuditLog(
        "warn",
        "[withAuth] Identity token verification failed, falling back to Privy users API",
        {
          path: req.nextUrl.pathname,
          privyDid,
          identityTokenSource,
          error: getErrorMessage(error),
        }
      );
    }
  }

  const privyUser = await privy.users()._get(privyDid);
  return {
    privyUser,
    source: "privyUsersApi",
    identityTokenSource,
  };
}

/**
 * Wraps an API route handler with Privy auth verification.
 * Automatically upserts the user record on first visit.
 */
export function withAuth<TParams extends RouteParams = Record<string, never>>(
  handler: RouteHandler<TParams>
) {
  return async (req: NextRequest, context: { params: Promise<TParams> }) => {
    try {
      if (!appId) {
        return NextResponse.json(
          {
            error: "Server auth configuration is incomplete",
            code: "AUTH_CONFIG_ERROR",
            detail:
              "Set PRIVY_APP_ID (or NEXT_PUBLIC_PRIVY_APP_ID) on the server.",
          },
          { status: 500 }
        );
      }

      const authHeader = req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const token = authHeader.replace("Bearer ", "").trim();
      if (!token || token === "undefined" || token === "null") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      let verifiedClaims: { user_id?: string } | null = null;
      let verificationMethod:
        | "verifyAccessToken"
        | "verifyAuthToken"
        | "localKey"
        | "jwks" = "verifyAccessToken";

      try {
        verifiedClaims = await privy.utils().auth().verifyAccessToken(token);
      } catch (verifyAccessTokenError: unknown) {
        try {
          const authClaims = await privy.utils().auth().verifyAuthToken(token);
          verifiedClaims = { user_id: authClaims.user_id };
          verificationMethod = "verifyAuthToken";
        } catch (verifyAuthTokenError: unknown) {
          try {
            const localKey = await getLocalVerificationKey();
            if (!localKey && !jwks) {
              throw new Error("No JWT verifier available (local key and JWKS missing)");
            }
            const { payload } = localKey
              ? await jwtVerify(token, localKey as Parameters<typeof jwtVerify>[1], {
                  issuer: "privy.io",
                  audience: appId,
                })
              : await jwtVerify(token, jwks!, {
                  issuer: "privy.io",
                  audience: appId,
                });

            verifiedClaims = {
              user_id:
                typeof payload.sub === "string" ? payload.sub : undefined,
            };
            verificationMethod = localKey ? "localKey" : "jwks";
          } catch (verifyJwtError: unknown) {
            if (isDevAuthLogging) safeAuditLog("error", "[withAuth] Token verification failed", {
              verifyAccessTokenError: getErrorMessage(verifyAccessTokenError),
              verifyAuthTokenError: getErrorMessage(verifyAuthTokenError),
              verifyJwtError: getErrorMessage(verifyJwtError),
              path: req.nextUrl.pathname,
              configuredAppId: appId,
              jwksEndpoint,
              hasLocalVerificationKey: Boolean(localVerificationKey),
              localKeySource,
              localKeyInitError,
            });
            return NextResponse.json(
              {
                error: "Failed to verify authentication token",
                code: "TOKEN_INVALID",
              },
              { status: 401 }
            );
          }
        }
      }

      if (!verifiedClaims?.user_id) {
        return NextResponse.json(
          {
            error: "Failed to verify authentication token",
            code: "TOKEN_INVALID",
          },
          { status: 401 }
        );
      }

      let privyUser: PrivyUser;
      let userLookupMethod: "identityToken" | "privyUsersApi" = "privyUsersApi";
      let identityTokenSource: "header" | "cookie" | "none" = "none";
      const observedIdentityTokenSource = extractIdentityToken(req).source;

      try {
        const resolved = await resolvePrivyUser(req, verifiedClaims.user_id);
        privyUser = resolved.privyUser;
        userLookupMethod = resolved.source;
        identityTokenSource = resolved.identityTokenSource;
      } catch (error: unknown) {
        const status = getStatusCode(error);
        if (status === 403) {
          if (isDevAuthLogging) safeAuditLog("error", "[withAuth] Privy user lookup forbidden", {
            path: req.nextUrl.pathname,
            privyDid: verifiedClaims.user_id,
            configuredAppId: appId,
            hasAppSecret: Boolean(appSecret),
            appSecretLength: appSecret.length,
            observedIdentityTokenSource,
            error: getErrorMessage(error),
          });

          return NextResponse.json(
            {
              error: "Auth backend cannot fetch Privy user profile",
              code: "PRIVY_USER_LOOKUP_FORBIDDEN",
              detail:
                "Server lookup to Privy users API was forbidden. Ensure NEXT_PUBLIC_PRIVY_CLIENT_ID is set so identity tokens are sent via cookie/header, and ensure PRIVY_APP_SECRET belongs to the same app as PRIVY_APP_ID/NEXT_PUBLIC_PRIVY_APP_ID.",
            },
            { status: 503 }
          );
        }

        if (status === 404) {
          return NextResponse.json(
            {
              error: "Failed to resolve authenticated user",
              code: "PRIVY_USER_NOT_FOUND",
            },
            { status: 401 }
          );
        }

        throw error;
      }

      const walletAddress = getSolanaWalletAddress(privyUser);
      const email = getEmailAddress(privyUser);

      if (!walletAddress) {
        if (isDevAuthLogging) safeAuditLog("warn", "[withAuth] WALLET_NOT_READY", {
          path: req.nextUrl.pathname,
          privyDid: verifiedClaims.user_id,
          accounts: privyUser.linked_accounts.map((a) => ({
            type: a.type,
            chain_type: (a as PrivyAAAccount).chain_type,
            hasAddress: Boolean((a as PrivyAAAccount).address),
          })),
        });

        return NextResponse.json(
          {
            error: "No Solana wallet found for this account yet.",
            code: "WALLET_NOT_READY",
            detail:
              "Please create your embedded Solana wallet and retry this action.",
          },
          { status: 403 }
        );
      }

      const user = await prisma.user.upsert({
        where: { wallet_address: walletAddress },
        create: {
          wallet_address: walletAddress,
          email,
        },
        update: {
          email,
        },
      });

      const authedReq = req as AuthedRequest;
      authedReq.user = user;
      authedReq.walletAddress = walletAddress;

      if (isDevAuthLogging) {
        safeAuditLog("log", "[withAuth] authenticated", {
          path: req.nextUrl.pathname,
          privyDid: verifiedClaims.user_id,
          verificationMethod,
          userLookupMethod,
          identityTokenSource,
          walletAddress,
          userId: user.id,
        });
      }

      return handler(authedReq, { params: await context.params });
    } catch (err) {
      if (isDevAuthLogging) safeAuditLog("error", "[withAuth] Unexpected error", {
        error: getErrorMessage(err),
      });
      return NextResponse.json(
        { error: "Authentication failed", code: "AUTH_UNEXPECTED_ERROR" },
        { status: 401 }
      );
    }
  };
}
