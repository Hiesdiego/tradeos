// app/src/lib/solana/escrow.ts

import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import {
  getSigningProgram,
  getConnection,
  deriveEscrowPda,
  deriveEscrowTokenPda,
  deriveMilestoneConfigPda,
  normalizeTradeSeed,
} from "./program";
import { USDC_MINT, USDC_FACTOR, ARBITER_WALLET } from "@/lib/constants";

const DEFAULT_ARBITRATION_FEE_BPS = 100; // 1%
const MAX_ARBITRATION_FEE_BPS = 500; // 5%

function computeArbitrationFeeUsdc(totalAmountUsdc: number): number {
  const feeBpsRaw = Number(process.env.ARBITRATION_FEE_BPS ?? DEFAULT_ARBITRATION_FEE_BPS);
  const feeBps = Number.isFinite(feeBpsRaw)
    ? Math.max(0, Math.min(MAX_ARBITRATION_FEE_BPS, Math.round(feeBpsRaw)))
    : DEFAULT_ARBITRATION_FEE_BPS;
  return Number(((totalAmountUsdc * feeBps) / 10_000).toFixed(6));
}

type SigningWallet = {
  publicKey: PublicKey;
  signTransaction: (tx: unknown) => Promise<unknown>;
  signAllTransactions: (txs: unknown[]) => Promise<unknown[]>;
};

// ---------------------------------------------------------------------------
// simulateAndSurface
//
// FIX FOR "SOMETHING WENT WRONG": Anchor swallows the real on-chain error
// and Privy shows a generic modal. This helper pre-simulates the transaction
// to extract and log the actual program logs before sending. That way, the
// real error (e.g. "InvalidMilestoneBps", "account already in use") appears
// in the browser console even when Privy hides it.
// ---------------------------------------------------------------------------
async function simulateAndSurface(
  label: string,
  fn: () => Promise<string>
): Promise<string> {
  try {
    return await fn();
  } catch (err: unknown) {
    // Extract logs from SendTransactionError (Anchor wraps on-chain failures)
    const anyErr = err as {
      logs?: string[];
      message?: string;
      transactionMessage?: string;
    };

    void anyErr?.logs;
    void label;
    void err;

    // Re-throw with the most informative message available
    const detail =
      anyErr?.transactionMessage ?? anyErr?.message ?? "Transaction failed";
    throw new Error(detail);
  }
}
// ---------------------------------------------------------------------------
// initializeEscrow
// ---------------------------------------------------------------------------
export async function initializeEscrow({
  wallet,
  tradeId,
  supplierWallet,
  totalAmountUsdc,
  milestoneBps,
}: {
  wallet: SigningWallet;
  tradeId: string;
  supplierWallet: string;
  totalAmountUsdc: number;
  milestoneBps: number[];
}): Promise<string> {
  // Guard: env vars must be set
  if (!ARBITER_WALLET) {
    throw new Error(
      "NEXT_PUBLIC_ARBITER_WALLET is not set. Check your .env.local file."
    );
  }
  if (!USDC_MINT) {
    throw new Error(
      "NEXT_PUBLIC_USDC_MINT is not set. Check your .env.local file."
    );
  }

  // Guard: BPS must sum to exactly 10 000
  const bpsSum = milestoneBps.reduce((a, b) => a + b, 0);
  if (bpsSum !== 10_000) {
    throw new Error(
      `milestone_bps must sum to 10 000 but got ${bpsSum}. ` +
        `Values: [${milestoneBps.join(", ")}]. ` +
        `Check that release_percentage in the DB is stored as integer percentages (e.g. 30, not 0.3).`
    );
  }

  const program = getSigningProgram(wallet);
  const tradeSeed = normalizeTradeSeed(tradeId);

  const [escrowPda] = deriveEscrowPda(tradeSeed);
  const [escrowTokenPda] = deriveEscrowTokenPda(escrowPda);
  const [milestoneConfigPda] = deriveMilestoneConfigPda(escrowPda);
  const usdcMint = new PublicKey(USDC_MINT);
  const totalAtoms = new BN(Math.round(totalAmountUsdc * USDC_FACTOR));
  const arbitrationFeeUsdc = computeArbitrationFeeUsdc(totalAmountUsdc);
  const feeBps = totalAmountUsdc > 0 ? Math.round((arbitrationFeeUsdc * 10_000) / totalAmountUsdc) : 0;

  return simulateAndSurface("initializeEscrow", () =>
    program.methods
      .initializeEscrow(
        tradeSeed,
        new PublicKey(supplierWallet),
        new PublicKey(ARBITER_WALLET),
        totalAtoms,
        milestoneBps,
        feeBps
      )
      .accounts({
        buyer: wallet.publicKey,
        escrow: escrowPda,
        milestoneConfig: milestoneConfigPda,
        escrowTokenAccount: escrowTokenPda,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" })
  );
}

// ---------------------------------------------------------------------------
// fundEscrow
// ---------------------------------------------------------------------------
export async function fundEscrow({
  wallet,
  tradeId,
  totalAmountUsdc,
  expectedNonce,
}: {
  wallet: SigningWallet;
  tradeId: string;
  totalAmountUsdc: number;
  expectedNonce: number;
}): Promise<string> {
  const program = getSigningProgram(wallet);
  const connection = getConnection();

  const [escrowPda] = deriveEscrowPda(tradeId);
  const [escrowTokenPda] = deriveEscrowTokenPda(escrowPda);
  const usdcMint = new PublicKey(USDC_MINT);

  const buyerAta = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  // Create buyer's ATA if it doesn't exist yet
  const ataInfo = await connection.getAccountInfo(buyerAta);
  const preInstructions: TransactionInstruction[] = [];
  if (!ataInfo) {    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        buyerAta,
        wallet.publicKey,
        usdcMint
      )
    );
  }

  // Check buyer has enough USDC before building the tx
  const ataBalance = ataInfo
    ? await connection.getTokenAccountBalance(buyerAta)
    : null;
  const requiredAtoms = Math.round(totalAmountUsdc * USDC_FACTOR);
  const actualAtoms = ataBalance
    ? Number(ataBalance.value.amount)
    : 0;
  if (actualAtoms < requiredAtoms) {
    throw new Error(
      `Insufficient USDC balance. ` +
        `Required: ${totalAmountUsdc} USDC, ` +
        `Available: ${actualAtoms / USDC_FACTOR} USDC. ` +
        `Fund your wallet with devnet USDC first.`
    );
  }

  const totalAtoms = new BN(requiredAtoms);

  return simulateAndSurface("fundEscrow", () =>
    program.methods
      .fundEscrow(totalAtoms, new BN(expectedNonce))
      .accounts({
        buyer: wallet.publicKey,
        escrow: escrowPda,
        escrowTokenAccount: escrowTokenPda,
        buyerTokenAccount: buyerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(preInstructions)
      .rpc({ commitment: "confirmed" })
  );
}

// ---------------------------------------------------------------------------
// releaseMilestone
// ---------------------------------------------------------------------------
export async function releaseMilestone({
  wallet,
  tradeId,
  milestoneIndex,
  supplierWallet,
  expectedNonce,
}: {
  wallet: SigningWallet;
  tradeId: string;
  milestoneIndex: number;
  supplierWallet: string;
  expectedNonce: number;
}): Promise<string> {
  const program = getSigningProgram(wallet);
  const connection = getConnection();

  const [escrowPda] = deriveEscrowPda(tradeId);
  const [escrowTokenPda] = deriveEscrowTokenPda(escrowPda);
  const [milestoneConfigPda] = deriveMilestoneConfigPda(escrowPda);
  const usdcMint = new PublicKey(USDC_MINT);
  const supplierPubkey = new PublicKey(supplierWallet);

  const supplierAta = await getAssociatedTokenAddress(usdcMint, supplierPubkey);
  const supplierAtaInfo = await connection.getAccountInfo(supplierAta);
  const preInstructions: TransactionInstruction[] = [];

  if (!supplierAtaInfo) {    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        supplierAta,
        supplierPubkey,
        usdcMint
      )
    );
  }

  return simulateAndSurface("releaseMilestone", () =>
    program.methods
      .releaseMilestone(milestoneIndex, new BN(expectedNonce))
      .accounts({
        buyer: wallet.publicKey,
        escrow: escrowPda,
        milestoneConfig: milestoneConfigPda,
        escrowTokenAccount: escrowTokenPda,
        supplierTokenAccount: supplierAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(preInstructions)
      .rpc({ commitment: "confirmed" })
  );
}

// ---------------------------------------------------------------------------
// resolveDispute
// ---------------------------------------------------------------------------
export async function resolveDispute({
  wallet,
  escrowPubkey,
  buyerWallet,
  supplierWallet,
  releaseToSupplierBps,
}: {
  wallet: SigningWallet;
  escrowPubkey: string;
  buyerWallet: string;
  supplierWallet: string;
  releaseToSupplierBps: number;
}): Promise<string> {
  if (!USDC_MINT) {
    throw new Error("NEXT_PUBLIC_USDC_MINT is not set. Check your .env.local file.");
  }

  const program = getSigningProgram(wallet);
  const connection = getConnection();
  const escrowPda = new PublicKey(escrowPubkey);
  const [escrowTokenPda] = deriveEscrowTokenPda(escrowPda);
  const usdcMint = new PublicKey(USDC_MINT);
  const buyerPubkey = new PublicKey(buyerWallet);
  const supplierPubkey = new PublicKey(supplierWallet);
  const buyerAta = await getAssociatedTokenAddress(usdcMint, buyerPubkey);
  const supplierAta = await getAssociatedTokenAddress(usdcMint, supplierPubkey);
  const arbiterPubkey = wallet.publicKey;
  const arbiterAta = await getAssociatedTokenAddress(usdcMint, arbiterPubkey);

  const preInstructions: TransactionInstruction[] = [];
  const arbiterAtaInfo = await connection.getAccountInfo(arbiterAta);
  if (!arbiterAtaInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        arbiterAta,
        arbiterPubkey,
        usdcMint
      )
    );
  }

  return simulateAndSurface("resolveDispute", () =>
    program.methods
      .resolveDispute(releaseToSupplierBps)
      .accounts({
        arbiter: wallet.publicKey,
        escrow: escrowPda,
        escrowTokenAccount: escrowTokenPda,
        supplierTokenAccount: supplierAta,
        buyerTokenAccount: buyerAta,
        arbiterTokenAccount: arbiterAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(preInstructions)
      .rpc({ commitment: "confirmed" })
  );
}

// ---------------------------------------------------------------------------
// raiseDispute
// ---------------------------------------------------------------------------
export async function raiseDispute({
  wallet,
  tradeId,
  milestoneIndex,
  reason,
  expectedNonce,
}: {
  wallet: SigningWallet;
  tradeId: string;
  milestoneIndex: number;
  reason: string;
  expectedNonce: number;
}): Promise<string> {
  const program = getSigningProgram(wallet);

  const [escrowPda] = deriveEscrowPda(tradeId);
  const [milestoneConfigPda] = deriveMilestoneConfigPda(escrowPda);

  return simulateAndSurface("raiseDispute", () =>
    program.methods
      .raiseDispute(milestoneIndex, reason, new BN(expectedNonce))
      .accounts({
        caller: wallet.publicKey,
        escrow: escrowPda,
        milestoneConfig: milestoneConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" })
  );
}

// ---------------------------------------------------------------------------
// refundEscrow
// ---------------------------------------------------------------------------
export async function refundEscrow({
  wallet,
  tradeId,
  expectedNonce,
}: {
  wallet: SigningWallet;
  tradeId: string;
  expectedNonce: number;
}): Promise<string> {
  const program = getSigningProgram(wallet);

  const [escrowPda] = deriveEscrowPda(tradeId);
  const [escrowTokenPda] = deriveEscrowTokenPda(escrowPda);
  const usdcMint = new PublicKey(USDC_MINT);
  const buyerAta = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  return simulateAndSurface("refundEscrow", () =>
    program.methods
      .refundEscrow(new BN(expectedNonce))
      .accounts({
        buyer: wallet.publicKey,
        escrow: escrowPda,
        escrowTokenAccount: escrowTokenPda,
        buyerTokenAccount: buyerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" })
  );
}

// ---------------------------------------------------------------------------
// fetchEscrowAccount
// ---------------------------------------------------------------------------
export async function fetchEscrowAccount(tradeId: string) {
  const { getReadonlyProgram } = await import("./program");
  const program = getReadonlyProgram();
  const [escrowPda] = deriveEscrowPda(tradeId);
  try {
    const accountNamespace = program.account as unknown as Record<
      string,
      { fetch: (pubkey: PublicKey) => Promise<unknown> }
    >;
    const accountFetcher =
      accountNamespace.tradeEscrow ??
      accountNamespace.TradeEscrow ??
      accountNamespace.escrow;
    if (!accountFetcher) return null;
    return await accountFetcher.fetch(escrowPda);
  } catch {
    return null;
  }
}
