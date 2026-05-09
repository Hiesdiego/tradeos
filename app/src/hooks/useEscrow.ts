"use client";

import { useState, useEffect, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { PublicKey } from "@solana/web3.js";
import toast from "react-hot-toast";
import {
  initializeEscrow,
  fundEscrow,
  releaseMilestone,
  raiseDispute,
  resolveDispute,
  refundEscrow,
  fetchEscrowAccount,
} from "@/lib/solana/escrow";
import { deriveEscrowPda, getConnection } from "@/lib/solana/program";
import { DEFAULT_MILESTONE_BPS, RPC_URL } from "@/lib/constants";
import { canonicalTradeTermsString } from "@/lib/trade/terms";
import type { Trade } from "@/types";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getTradeTermsSeed(trade: Trade): Promise<string> {
  const canonical = canonicalTradeTermsString({
    trade_number: trade.trade_number,
    buyer_wallet_address: trade.buyer?.wallet_address ?? null,
    supplier_wallet_address: trade.supplier?.wallet_address ?? null,
    goods_description: trade.goods_description,
    goods_category: trade.goods_category,
    quantity: trade.quantity,
    total_amount_usdc: trade.total_amount_usdc,
    corridor: trade.corridor,
    pickup_location: trade.pickup_location,
    dropoff_location: trade.dropoff_location,
    buyer_contact_name: trade.buyer_contact_name,
    buyer_contact_phone: trade.buyer_contact_phone,
    supplier_contact_name: trade.supplier_contact_name,
    supplier_contact_phone: trade.supplier_contact_phone,
    expected_ship_date: trade.expected_ship_date,
    expected_delivery_date: trade.expected_delivery_date,
    shipping_reference: trade.shipping_reference,
    incoterm: trade.incoterm,
    notes: trade.notes,
    milestones: (trade.milestones ?? []).map((m) => ({
      milestone_number: m.milestone_number,
      description: m.description,
      release_percentage: m.release_percentage,
    })),
  });
  return sha256Hex(canonical);
}

function toNonce(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object") {
    const maybe = value as { toNumber?: () => number; toString?: () => string };
    if (typeof maybe.toNumber === "function") return maybe.toNumber();
    if (typeof maybe.toString === "function") {
      const parsed = Number(maybe.toString());
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

async function getActionNonce(
  tradeSeed: string,
  field: "fund_nonce" | "release_nonce" | "dispute_nonce" | "refund_nonce"
): Promise<number> {
  const escrow = (await fetchEscrowAccount(tradeSeed)) as
    | Record<string, unknown>
    | null;
  if (!escrow) {
    throw new Error("Escrow account not found on-chain for nonce check");
  }
  const camelField = field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const value = escrow[field] ?? escrow[camelField];
  return toNonce(value);
}

// ---------------------------------------------------------------------------
// PrivyWallet type helper
// ---------------------------------------------------------------------------
type PrivyWalletExtra = {
  address: string;
  walletClientType?: string;
  connectorType?: string;
  meta?: { id?: string; name?: string };
  isConnected?: () => Promise<boolean>;
  features?: Record<string, unknown>;
  standardWallet?: {
    name?: string;
    isPrivyWallet?: boolean;
  };
  signTransaction: (tx: unknown) => Promise<unknown>;
  sendTransaction?: (tx: unknown) => Promise<unknown>;
};

async function ensureWalletConnected(wallet: PrivyWalletExtra) {
  try {
    const connected = await wallet.isConnected?.();
    if (connected) return;

    const connectFeature = (
      wallet.features?.["standard:connect"] as
        | { connect?: () => Promise<unknown> }
        | undefined
    )?.connect;

    if (connectFeature) {
      await connectFeature();
    }
  } catch (err) {
    void err;
  }
}
function toNativeUint8Array(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return null;
}

function extractSignatureFromSendResult(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;
  if ("signature" in result && typeof (result as { signature?: unknown }).signature === "string") {
    return (result as { signature: string }).signature;
  }
  if ("signatures" in result) {
    const signatures = (result as { signatures?: unknown }).signatures;
    if (Array.isArray(signatures) && typeof signatures[0] === "string") {
      return signatures[0];
    }
  }
  return null;
}

function trySerializeTransaction(input: unknown): Uint8Array | null {
  if (!input || typeof input !== "object") return null;
  const serialize = (input as { serialize?: (...args: unknown[]) => unknown }).serialize;
  if (typeof serialize !== "function") return null;

  try {
    const maybeLegacy = serialize.call(input, {
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const nativeLegacy = toNativeUint8Array(maybeLegacy);
    if (nativeLegacy) return nativeLegacy;
  } catch {
    // fall through to no-arg serialize path
  }

  try {
    const maybeVersioned = serialize.call(input);
    return toNativeUint8Array(maybeVersioned);
  } catch {
    return null;
  }
}

function inferSolanaChainFromRpc(): "solana:mainnet" | "solana:devnet" | "solana:testnet" {
  const rpc = RPC_URL.toLowerCase();
  if (rpc.includes("devnet")) return "solana:devnet";
  if (rpc.includes("testnet")) return "solana:testnet";
  return "solana:mainnet";
}

// ---------------------------------------------------------------------------
// useEmbeddedWallet
// ---------------------------------------------------------------------------
function useEmbeddedWallet() {
  const { ready } = usePrivy();
  const { wallets } = useWallets();
  const [walletReady, setWalletReady] = useState(false);
  const [resolvedWallet, setResolvedWallet] = useState<PrivyWalletExtra | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!ready) {
      setWalletReady(false);
      setResolvedWallet(null);
      return;
    }

    function resolve() {
      const allWallets = wallets as unknown as PrivyWalletExtra[];

      // Prefer the Privy embedded wallet
      const embedded = allWallets.find(
        (w) =>
          w.walletClientType === "privy" ||
          w.standardWallet?.isPrivyWallet === true ||
          w.standardWallet?.name === "Privy"
      );

      // Fallback: any wallet with an address (external sign-in wallet)
      const fallback = allWallets.find((w) => w.address);

      const chosen = embedded ?? fallback ?? null;

      if (chosen?.address) {
        setResolvedWallet(chosen);
        setWalletReady(true);
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } else {
        setWalletReady(false);
        setResolvedWallet(null);
      }
    }

    resolve();

    if (!resolvedWallet) {
      pollRef.current = setInterval(resolve, 500);
      const timeout = setTimeout(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 10_000);

      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
        clearTimeout(timeout);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, wallets]);

  let signingWallet: {
    publicKey: PublicKey;
    signTransaction: (tx: unknown) => Promise<unknown>;
    sendTransaction?: (
      tx: unknown,
      options?: { sponsor?: boolean }
    ) => Promise<unknown>;
    signAllTransactions: (txs: unknown[]) => Promise<unknown[]>;
  } | null = null;

  if (resolvedWallet) {
    const chain = inferSolanaChainFromRpc();

    const signOne = async (tx: unknown): Promise<unknown> => {
      await ensureWalletConnected(resolvedWallet);

      const nativeBytes = toNativeUint8Array(tx) ?? trySerializeTransaction(tx);
      const walletId =
        resolvedWallet.walletClientType ??
        resolvedWallet.connectorType ??
        resolvedWallet.meta?.name ??
        resolvedWallet.address.slice(0, 8);

      const attempts: Array<{ label: string; exec: () => Promise<unknown> }> = [];

      if (nativeBytes) {
        attempts.push({
          label: "bytes",
          exec: () => resolvedWallet.signTransaction(nativeBytes),
        });
        attempts.push({
          label: "args(transaction,wallet,chain,address)",
          exec: () =>
            resolvedWallet.signTransaction({
              transaction: nativeBytes,
              wallet: resolvedWallet,
              address: resolvedWallet.address,
              chain,
            }),
        });
        attempts.push({
          label: "args(transaction,address,chain)",
          exec: () =>
            resolvedWallet.signTransaction({
              transaction: nativeBytes,
              address: resolvedWallet.address,
              chain,
            }),
        });
        attempts.push({
          label: "args(transaction,chain)",
          exec: () =>
            resolvedWallet.signTransaction({
              transaction: nativeBytes,
              chain,
            }),
        });

        const signFeature = (
          resolvedWallet.features?.["solana:signTransaction"] as
            | {
                signTransaction?: (...inputs: unknown[]) => Promise<unknown>;
              }
            | undefined
        )?.signTransaction;

        if (signFeature) {
          attempts.push({
            label: "feature(solana:signTransaction)",
            exec: async () => {
              const account =
                (resolvedWallet as { accounts?: unknown[] }).accounts?.[0] ??
                undefined;
              const featureResult = await signFeature({
                account,
                chain,
                transaction: nativeBytes,
              });
              return Array.isArray(featureResult) ? featureResult[0] : featureResult;
            },
          });
        }
      }

      attempts.push({
        label: "raw",
        exec: () => resolvedWallet.signTransaction(tx),
      });

      const errors: string[] = [];
      for (const attempt of attempts) {
        try {
          const result = await attempt.exec();
          if (
            result &&
            typeof result === "object" &&
            "signedTransaction" in (result as object)
          ) {
            return (result as { signedTransaction: unknown }).signedTransaction;
          }
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${attempt.label}: ${message}`);
        }
      }

      throw new Error(`Wallet signing failed (${walletId}): ${errors.join(" | ")}`);
    };

    signingWallet = {
      publicKey: new PublicKey(resolvedWallet.address),
      signTransaction: signOne,
      sendTransaction: async (
        tx: unknown,
        options?: { sponsor?: boolean }
      ) => {
        await ensureWalletConnected(resolvedWallet);
        const sponsor = options?.sponsor ?? true;
        const nativeBytes = toNativeUint8Array(tx) ?? trySerializeTransaction(tx);
        const account =
          (resolvedWallet as { accounts?: unknown[] }).accounts?.[0] ?? undefined;
        const signAndSendFeature = (
          resolvedWallet.features?.["solana:signAndSendTransaction"] as
            | {
                signAndSendTransaction?: (...inputs: unknown[]) => Promise<unknown>;
              }
            | undefined
        )?.signAndSendTransaction;

        const attempts: Array<{ label: string; exec: () => Promise<unknown> }> = [];
        if (signAndSendFeature && nativeBytes) {
          attempts.push({
            label: "feature(solana:signAndSendTransaction+options.sponsor)",
            exec: () =>
              signAndSendFeature({
                account,
                chain,
                transaction: nativeBytes,
                options: {
                  sponsor,
                },
              }),
          });
          attempts.push({
            label: "feature(solana:signAndSendTransaction+sponsor)",
            exec: () =>
              signAndSendFeature({
                account,
                chain,
                transaction: nativeBytes,
                sponsor,
              }),
          });
          attempts.push({
            label: "feature(solana:signAndSendTransaction/no-sponsor)",
            exec: () =>
              signAndSendFeature({
                account,
                chain,
                transaction: nativeBytes,
              }),
          });
        }
        if (resolvedWallet.sendTransaction && nativeBytes) {
          attempts.push({
            label: "wallet.sendTransaction(args+options.sponsor)",
            exec: () =>
              resolvedWallet.sendTransaction!({
                transaction: nativeBytes,
                address: resolvedWallet.address,
                chain,
                options: {
                  sponsor,
                },
              }),
          });
          attempts.push({
            label: "wallet.sendTransaction(args+sponsor)",
            exec: () =>
              resolvedWallet.sendTransaction!({
                transaction: nativeBytes,
                address: resolvedWallet.address,
                chain,
                sponsor,
              }),
          });
          attempts.push({
            label: "wallet.sendTransaction(args)",
            exec: () =>
              resolvedWallet.sendTransaction!({
                transaction: nativeBytes,
                address: resolvedWallet.address,
                chain,
              }),
          });
          attempts.push({
            label: "wallet.sendTransaction(bytes)",
            exec: () => resolvedWallet.sendTransaction!(nativeBytes),
          });
        }
        if (resolvedWallet.sendTransaction) {
          attempts.push({
            label: "wallet.sendTransaction(raw-tx)",
            exec: () => resolvedWallet.sendTransaction!(tx),
          });
        }
        if (attempts.length === 0) {
          throw new Error(
            "Wallet sendTransaction unavailable: no compatible Solana send feature found."
          );
        }

        const errors: string[] = [];
        for (const attempt of attempts) {
          try {
            const result = await attempt.exec();
            const sig = extractSignatureFromSendResult(result);
            if (sig) return sig;
            errors.push(`${attempt.label}: missing signature in response`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`${attempt.label}: ${message}`);
          }
        }

        throw new Error(`Wallet sendTransaction failed: ${errors.join(" | ")}`);
      },
      signAllTransactions: async (txs: unknown[]) => Promise.all(txs.map((tx) => signOne(tx))),
    };
  }

  return { signingWallet, walletReady, walletAddress: resolvedWallet?.address ?? null };
}

// ---------------------------------------------------------------------------
// milestoneBps builder + validator
// ---------------------------------------------------------------------------
function buildMilestoneBps(milestones: Trade["milestones"]): number[] {
  if (!milestones || milestones.length === 0) {
    return DEFAULT_MILESTONE_BPS;
  }

  const bps = milestones.map((m) => {
    const pct = Number(m.release_percentage);
    return pct > 0 && pct <= 1
      ? Math.round(pct * 10_000)
      : Math.round(pct * 100);
  });

  const sum = bps.reduce((a, b) => a + b, 0);

  if (sum !== 10_000) {
    throw new Error(
      `Milestone BPS must sum to 10 000, got ${sum}. ` +
        `Values: [${bps.join(", ")}]. ` +
        `Ensure release_percentage is stored as integers (e.g. 30, not 0.3).`
    );
  }

  return bps;
}

// ---------------------------------------------------------------------------
// useEscrow
// ---------------------------------------------------------------------------
export function useEscrow() {
  const [loading, setLoading] = useState(false);
  const { signingWallet, walletReady, walletAddress } = useEmbeddedWallet();

  // -------------------------------------------------------------------------
  // handleFundEscrow
  // -------------------------------------------------------------------------
  async function handleFundEscrow(trade: Trade): Promise<{
    initTx: string | null;
    fundTx: string;
    escrowPubkey: string;
  }> {
    if (!walletReady || !signingWallet) {
      const msg = "Wallet is not ready. Please wait a moment and try again, or refresh the page.";
      toast.error(msg);
      throw new Error(msg);
    }

    if (!trade.supplier?.wallet_address)
      throw new Error("Supplier wallet not found on trade");

    const milestoneBps = buildMilestoneBps(trade.milestones);
    const tradeSeed = await getTradeTermsSeed(trade);

    setLoading(true);
    const toastId = toast.loading("Preparing escrow on Solana...");

    try {
      const connection = getConnection();
      const [escrowPda] = deriveEscrowPda(tradeSeed);
      const escrowPubkey = escrowPda.toBase58();
      const existingAccount = await connection.getAccountInfo(escrowPda);

      let initTx: string | null = null;

      if (existingAccount) {
        toast.loading("Escrow found — depositing USDC...", { id: toastId });
      } else {
        toast.loading("Initializing escrow on Solana...", { id: toastId });
        initTx = await initializeEscrow({
          wallet: signingWallet,
          tradeId: tradeSeed,
          supplierWallet: trade.supplier.wallet_address,
          totalAmountUsdc: Number(trade.total_amount_usdc),
          milestoneBps,
        });
        toast.loading("Depositing USDC into escrow...", { id: toastId });
      }

      const fundTx = await fundEscrow({
        wallet: signingWallet,
        tradeId: tradeSeed,
        totalAmountUsdc: Number(trade.total_amount_usdc),
        expectedNonce: await getActionNonce(tradeSeed, "fund_nonce"),
      });
      toast.success("Escrow funded successfully!", { id: toastId });
      return { initTx, fundTx, escrowPubkey };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      toast.error(msg, { id: toastId });
      throw err;
    } finally {
      setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // handleReleaseMilestone
  // -------------------------------------------------------------------------
  async function handleReleaseMilestone(
    trade: Trade,
    milestoneIndex: number
  ): Promise<string> {
    if (!walletReady || !signingWallet)
      throw new Error("No Solana wallet connected");
    if (!trade.supplier?.wallet_address)
      throw new Error("Supplier wallet not found");
    const tradeSeed = await getTradeTermsSeed(trade);

    setLoading(true);
    const toastId = toast.loading(`Releasing milestone ${milestoneIndex + 1}...`);

    try {
      const tx = await releaseMilestone({
        wallet: signingWallet,
        tradeId: tradeSeed,
        milestoneIndex,
        supplierWallet: trade.supplier.wallet_address,
        expectedNonce: await getActionNonce(tradeSeed, "release_nonce"),
      });
      toast.success("Milestone released!", { id: toastId });
      return tx;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Release failed";
      toast.error(msg, { id: toastId });
      throw err;
    } finally {
      setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // handleRaiseDispute
  // -------------------------------------------------------------------------
  async function handleRaiseDispute(
    trade: Trade,
    milestoneIndex: number,
    reason: string
  ): Promise<string | null> {
    if (!walletReady || !signingWallet)
      throw new Error("No Solana wallet connected");
    const tradeSeed = await getTradeTermsSeed(trade);

    setLoading(true);
    const toastId = toast.loading("Raising dispute...");

    try {
      const expectedNonce = await getActionNonce(tradeSeed, "dispute_nonce").catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Escrow account not found on-chain for nonce check")) {
          return null;
        }
        throw err;
      });
      if (expectedNonce == null) {
        toast("Escrow not found on-chain. Opening off-chain dispute fallback.", {
          id: toastId,
          icon: "⚠️",
        });
        return null;
      }

      const tx = await raiseDispute({
        wallet: signingWallet,
        tradeId: tradeSeed,
        milestoneIndex,
        reason,
        expectedNonce,
      });
      toast.success("Dispute raised. Escrow frozen.", { id: toastId });
      return tx;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Dispute failed";
      toast.error(msg, { id: toastId });
      throw err;
    } finally {
      setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // handleRefund
  // -------------------------------------------------------------------------
  async function handleRefund(trade: Trade): Promise<string> {
    if (!walletReady || !signingWallet)
      throw new Error("No Solana wallet connected");
    const tradeSeed = await getTradeTermsSeed(trade);

    setLoading(true);
    const toastId = toast.loading("Processing refund...");

    try {
      const tx = await refundEscrow({
        wallet: signingWallet,
        tradeId: tradeSeed,
        expectedNonce: await getActionNonce(tradeSeed, "refund_nonce"),
      });
      toast.success("Refund complete. USDC returned.", { id: toastId });
      return tx;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Refund failed";
      toast.error(msg, { id: toastId });
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function handleResolveDispute(
    trade: Trade,
    releaseToSupplierBps: number
  ): Promise<string> {
    if (!walletReady || !signingWallet) {
      throw new Error("No Solana wallet connected");
    }
    if (!trade.buyer?.wallet_address || !trade.supplier?.wallet_address) {
      throw new Error("Trade buyer/supplier wallet is missing");
    }

    if (!trade.escrow_pubkey) {
      throw new Error("Trade escrow pubkey is missing");
    }

    setLoading(true);
    const toastId = toast.loading("Resolving dispute on-chain...");
    try {
      const tx = await resolveDispute({
        wallet: signingWallet,
        escrowPubkey: trade.escrow_pubkey,
        buyerWallet: trade.buyer.wallet_address,
        supplierWallet: trade.supplier.wallet_address,
        releaseToSupplierBps,
      });
      toast.success("Dispute resolved and arbiter fee paid on-chain.", { id: toastId });
      return tx;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Dispute resolution failed";
      toast.error(msg, { id: toastId });
      throw err;
    } finally {
      setLoading(false);
    }
  }

  return {
    loading,
    walletReady,
    walletAddress,
    handleFundEscrow,
    handleReleaseMilestone,
    handleRaiseDispute,
    handleResolveDispute,
    handleRefund,
    fetchEscrowAccount,
  };
}
