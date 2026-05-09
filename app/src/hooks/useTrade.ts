//tradeos/app/src/hooks/useTrade.ts

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import toast from "react-hot-toast";
import type { Trade } from "@/types";

type AccessTokenGetter = () => Promise<string | null | undefined>;

async function readResponsePayload(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function apiFetch<T = unknown>(
  url: string,
  getAccessToken: AccessTokenGetter,
  options: RequestInit = {}
) : Promise<T> {
  const token = await getAccessToken();

  if (!token) {
    throw new Error("No access token available");
  }

  const hasFormDataBody = options.body instanceof FormData;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(hasFormDataBody ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });

  const payload = await readResponsePayload(res);
  if (!res.ok) {
    const apiError =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : null;

    const fallback =
      typeof payload === "string" && payload.length > 0
        ? payload.slice(0, 180)
        : `HTTP ${res.status}`;

    const method = options.method ?? "GET";
    throw new Error(`${apiError ?? fallback} [${method} ${url}]`);
  }

  return payload as T;
}

function newIdempotencyKey(prefix: string): string {
  const nonce =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${nonce}`;
}

/**
 * useStableAccessToken
 *
 * THE FIX for the auto-refresh / infinite polling loop.
 *
 * Problem: Privy's `getAccessToken` changes reference whenever Privy
 * updates its internal auth state (token refresh, re-render after a
 * successful fetch, etc.). Placing it in useCallback deps causes:
 *   getAccessToken changes → fetchTrade new ref → useEffect fires
 *   → setLoading(true) → skeleton flash → fetch → setTrade → re-render
 *   → getAccessToken changes again → loop.
 *
 * Solution: store getAccessToken in a ref that updates every render.
 * Expose a stable wrapper that never changes reference, so it's safe
 * to use in useCallback without including it in deps.
 */
function useStableAccessToken() {
  const { getAccessToken } = usePrivy();
  const ref = useRef(getAccessToken);
  useEffect(() => {
    ref.current = getAccessToken;
  }, [getAccessToken]);
  return useCallback(() => ref.current(), []);
}

/** Fetches all trades for the current user */
export function useTrades() {
  const getToken = useStableAccessToken();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Trade[]>("/api/trades", getToken);
      setTrades(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load trades";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [getToken]); // getToken is stable — this callback never needlessly recreates

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  return { trades, loading, error, refetch: fetchTrades };
}

/** Fetches a single trade by ID, with silent background-refetch support */
export function useTradeDetail(tradeId: string, inviteToken?: string | null) {
  const getToken = useStableAccessToken();
  const [trade, setTrade] = useState<Trade | null>(null);
  const [loading, setLoading] = useState(true); // true only for first load
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  /**
   * fetchTrade(silent?)
   * silent=true  → data updates in background, no skeleton shown (used by polling)
   * silent=false → shows loading skeleton (only on initial mount / trade change)
   */
  const fetchTrade = useCallback(
    async (silent = false) => {
      if (!tradeId) return;
      if (!silent) setLoading(true);
      setError(null);

      try {
        const inviteQuery = inviteToken
          ? `?invite_token=${encodeURIComponent(inviteToken)}`
          : "";
        const data = await apiFetch<Trade>(
          `/api/trades/${tradeId}${inviteQuery}`,
          getToken
        );
        setTrade(data);
        hasLoadedRef.current = true;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to load trade";
        if (!hasLoadedRef.current) setError(msg); // only show error on first load
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [tradeId, inviteToken, getToken]
  );

  // Initial fetch — reset hasLoadedRef so skeleton shows if tradeId changes
  useEffect(() => {
    hasLoadedRef.current = false;
    fetchTrade(false);
  }, [fetchTrade]);

  // Public refetch: always silent so background polls don't flash the skeleton
  const refetch = useCallback(() => fetchTrade(true), [fetchTrade]);

  return { trade, loading, error, refetch };
}

/** Mutations — create, accept, fund, proof, release, dispute */
export function useTradeActions() {
  const getToken = useStableAccessToken();
  const [loading, setLoading] = useState(false);

  async function createTrade(payload: {
    goods_description: string;
    goods_category?: string;
    quantity?: string;
    total_amount_usdc: number;
    corridor?: string;
    pickup_location?: string;
    dropoff_location?: string;
    buyer_contact_name?: string;
    buyer_contact_phone?: string;
    supplier_contact_name?: string;
    supplier_contact_phone?: string;
    expected_ship_date?: string;
    expected_delivery_date?: string;
    shipping_reference?: string;
    incoterm?: string;
    notes?: string;
    milestones?: { description: string; release_percentage: number }[];
    buyer_terms_accepted?: boolean;
  }): Promise<Trade> {
    setLoading(true);
    try {
      const trade = await apiFetch<Trade>("/api/trades", getToken, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast.success(`Trade ${trade.trade_number} created`);
      return trade;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create trade";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function acceptTrade(tradeId: string, invite_token: string): Promise<Trade> {
    setLoading(true);
    try {
      const trade = await apiFetch<Trade>(`/api/trades/${tradeId}/accept`, getToken, {
        method: "POST",
        body: JSON.stringify({ invite_token }),
      });
      toast.success("Trade accepted. Buyer can now fund escrow.");
      return trade;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to accept trade";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function declineTrade(tradeId: string, invite_token: string): Promise<Trade> {
    setLoading(true);
    try {
      const trade = await apiFetch<Trade>(`/api/trades/${tradeId}/decline`, getToken, {
        method: "POST",
        body: JSON.stringify({ invite_token }),
      });
      toast.success("Trade declined");
      return trade;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to decline trade";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function recordFunding(
    tradeId: string,
    escrow_pubkey: string,
    tx_signature: string
  ): Promise<Trade> {
    setLoading(true);
    try {
      return await apiFetch<Trade>(`/api/trades/${tradeId}/fund`, getToken, {
        method: "POST",
        headers: { "Idempotency-Key": newIdempotencyKey(`fund-${tradeId}`) },
        body: JSON.stringify({ escrow_pubkey, tx_signature }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to record funding";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function uploadProof(
    tradeId: string,
    milestone_number: number,
    proof_url: string
  ): Promise<void> {
    setLoading(true);
    try {
      await apiFetch(`/api/trades/${tradeId}/proof`, getToken, {
        method: "POST",
        body: JSON.stringify({ milestone_number, proof_url }),
      });
      toast.success("Proof uploaded successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to upload proof";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function rejectProof(
    tradeId: string,
    milestone_number: number,
    reason: string
  ): Promise<void> {
    setLoading(true);
    try {
      await apiFetch(`/api/trades/${tradeId}/proof/reject`, getToken, {
        method: "POST",
        body: JSON.stringify({ milestone_number, reason }),
      });
      toast.success("Proof rejected. Supplier must upload a new proof.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reject proof";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function uploadProofFile(
    tradeId: string,
    milestone_number: number,
    files: File[],
    anchorFn?: (proofHashSha256: string) => Promise<string>
  ): Promise<void> {
    setLoading(true);
    try {
      if (!files.length) throw new Error("Select at least one proof file");
      const uploadedProofFiles: Array<{
        url: string;
        hash_sha256: string;
        anchor_tx: string | null;
        mime: string | null;
      }> = [];
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        form.append("tradeId", tradeId);
        form.append("milestoneNumber", String(milestone_number));

        const uploadResponse = await apiFetch<{
          secure_url?: string;
          proof_hash_sha256?: string;
          file_mime?: string;
        }>("/api/uploads/proof", getToken, {
          method: "POST",
          body: form,
        });

        const secureUrl = uploadResponse.secure_url as string | undefined;
        const proofHash = uploadResponse.proof_hash_sha256 as string | undefined;
        if (!secureUrl) throw new Error("Upload response missing secure_url");
        if (!proofHash) throw new Error("Upload response missing proof_hash_sha256");
        const proofAnchorTx = anchorFn ? await anchorFn(proofHash) : undefined;
        uploadedProofFiles.push({
          url: secureUrl,
          hash_sha256: proofHash,
          anchor_tx: proofAnchorTx ?? null,
          mime: uploadResponse.file_mime ?? file.type ?? null,
        });
      }

      await apiFetch(`/api/trades/${tradeId}/proof`, getToken, {
        method: "POST",
        body: JSON.stringify({
          milestone_number,
          proof_files: uploadedProofFiles,
        }),
      });
      toast.success("Proof uploaded successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to upload proof";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function runMilestoneAiCheck(
    tradeId: string,
    milestone_number: number
  ): Promise<{
    id: string;
    created_at: string;
    verdict: string;
    confidence: number | null;
    summary: string;
    findings: unknown;
  }> {
    setLoading(true);
    try {
      return await apiFetch(`/api/trades/${tradeId}/milestones/${milestone_number}/ai-check`, getToken, {
        method: "POST",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI check failed";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function recordRelease(
    tradeId: string,
    milestone_number: number,
    tx_signature: string
  ): Promise<Trade> {
    setLoading(true);
    try {
      return await apiFetch<Trade>(`/api/trades/${tradeId}/release`, getToken, {
        method: "POST",
        headers: {
          "Idempotency-Key": newIdempotencyKey(
            `release-${tradeId}-${milestone_number}`
          ),
        },
        body: JSON.stringify({ milestone_number, tx_signature }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to record release";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function openDispute(
    tradeId: string,
    milestone_number: number,
    reason: string,
    tx_signature?: string | null
  ): Promise<void> {
    setLoading(true);
    try {
      await apiFetch(`/api/trades/${tradeId}/dispute`, getToken, {
        method: "POST",
        body: JSON.stringify({
          milestone_number,
          reason,
          ...(tx_signature ? { tx_signature } : {}),
        }),
      });
      toast.success("Dispute opened. Escrow frozen.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to open dispute";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function deleteTrade(tradeId: string): Promise<void> {
    setLoading(true);
    try {
      await apiFetch(`/api/trades/${tradeId}`, getToken, {
        method: "DELETE",
      });
      toast.success("Trade deleted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete trade";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function syncTradeFromChain(
    tradeId: string
  ): Promise<{
    synced: boolean;
    released_count: number;
    next_milestone_number: number | null;
  }> {
    setLoading(true);
    try {
      return await apiFetch(`/api/trades/${tradeId}/sync-chain`, getToken, {
        method: "POST",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to sync trade from chain";
      toast.error(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  return {
    loading,
    createTrade,
    acceptTrade,
    declineTrade,
    recordFunding,
    uploadProof,
    uploadProofFile,
    runMilestoneAiCheck,
    rejectProof,
    recordRelease,
    syncTradeFromChain,
    openDispute,
    deleteTrade,
  };
}
