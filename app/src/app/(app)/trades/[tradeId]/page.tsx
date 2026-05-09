//tradeos/app/src/app/(app)/trades/[tradeId]/page.tsx

"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ExternalLink,
  Upload,
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Lock,
  Unlock,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Bot,
} from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import toast from "react-hot-toast";
import { useTradeDetail, useTradeActions } from "@/hooks/useTrade";
import { useEscrow } from "@/hooks/useEscrow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TradeChat } from "@/components/trade/TradeChat";
import {
  formatUsdc,
  shortAddress,
  formatDate,
  solscanTxUrl,
  solscanAccountUrl,
  cn,
} from "@/lib/utils";
import { TRADE_STATUS_COLORS, TRADE_STATUS_LABELS } from "@/lib/constants";
import type { Milestone, Trade } from "@/types";

// ---------------------------------------------------------------------------
// MilestoneStep
// ---------------------------------------------------------------------------
function MilestoneStep({
  milestone,
  trade,
  isBuyer,
  isSupplier,
  onProofUpload,
  onRelease,
  onDispute,
  onRejectProof,
  onAiCheck,
  actionLoading,
  isUploadingThisMilestone,
  isRejectingThisMilestone,
  isAiCheckingThisMilestone,
  canUploadProof,
  canUseAiCheck,
}: {
  milestone: Milestone;
  trade: Trade;
  isBuyer: boolean;
  isSupplier: boolean;
  onProofUpload: (milestoneNumber: number, files: File[]) => void;
  onRelease: (milestoneNumber: number) => void;
  onDispute: (milestoneNumber: number) => void;
  onRejectProof: (milestoneNumber: number) => void;
  onAiCheck: (milestoneNumber: number) => void;
  actionLoading: boolean;
  isUploadingThisMilestone: boolean;
  isRejectingThisMilestone: boolean;
  isAiCheckingThisMilestone: boolean;
  canUploadProof: boolean;
  canUseAiCheck: boolean;
}) {
  const [proofFiles, setProofFiles] = useState<File[]>([]);
  const [showProofInput, setShowProofInput] = useState(false);

  const releaseAmount = trade.total_amount_usdc
    ? (Number(trade.total_amount_usdc) * milestone.release_percentage) / 100
    : 0;

  const statusConfig = {
    pending: {
      icon: Clock,
      color: "text-muted-foreground",
      label: "Pending",
    },
    proof_uploaded: {
      icon: Upload,
      color: "text-gold",
      label: "Proof Uploaded",
    },
    released: {
      icon: CheckCircle2,
      color: "text-green-400",
      label: "Released",
    },
    disputed: {
      icon: AlertTriangle,
      color: "text-red-400",
      label: "Disputed",
    },
  };

  const config = statusConfig[milestone.status];
  const Icon = config.icon;
  const latestAiCheck = milestone.ai_checks?.[0];
  const aiFindings =
    latestAiCheck?.findings_json && typeof latestAiCheck.findings_json === "object"
      ? (latestAiCheck.findings_json as {
          missing_documents?: string[];
          risk_flags?: string[];
          recommended_next_actions?: string[];
        })
      : null;
  const aiVerdictTone =
    latestAiCheck?.verdict === "pass"
      ? "text-green-300 border-green-500/40 bg-green-500/10"
      : latestAiCheck?.verdict === "fail"
        ? "text-red-300 border-red-500/40 bg-red-500/10"
        : "text-yellow-200 border-yellow-500/40 bg-yellow-500/10";

  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "w-8 h-8 rounded-full border-2 flex items-center justify-center flex-shrink-0",
            milestone.status === "released"
              ? "border-green-400 bg-green-400/10"
              : milestone.status === "proof_uploaded"
                ? "border-gold bg-[hsl(var(--gold)/0.1)]"
                : milestone.status === "disputed"
                  ? "border-red-400 bg-red-400/10"
                  : "border-border bg-muted/30"
          )}
        >
          <Icon className={cn("w-3.5 h-3.5", config.color)} />
        </div>
        <div className="w-px flex-1 bg-border mt-2 mb-2" />
      </div>

      <div className="flex-1 pb-6">
        <div className="flex items-start justify-between mb-1">
          <div>
            <span className="text-xs text-muted-foreground font-mono">
              Milestone {milestone.milestone_number}
            </span>
            <h3 className="text-sm font-semibold">{milestone.description}</h3>
          </div>
          <div className="text-right">
            <p className="text-sm font-mono font-bold text-gold">
              ${formatUsdc(releaseAmount)}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {milestone.release_percentage}% of total
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <span className={cn("text-xs", config.color)}>{config.label}</span>
          {milestone.released_at && (
            <span className="text-[10px] text-muted-foreground">
              Released {formatDate(milestone.released_at)}
            </span>
          )}
          {milestone.tx_signature && (
            <a
              href={solscanTxUrl(milestone.tx_signature)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted-foreground hover:text-gold flex items-center gap-0.5 transition-colors"
            >
              <ExternalLink className="w-2.5 h-2.5" /> Solscan
            </a>
          )}
        </div>

        {(milestone.proofs?.length
          ? milestone.proofs
          : milestone.proof_url
          ? [{ id: "legacy", file_url: milestone.proof_url, file_mime: null }]
          : []
        ).map((p, idx) => (
          <a
            key={`${p.id}-${idx}`}
            href={p.file_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-gold hover:underline mb-2 mr-3"
          >
            <ExternalLink className="w-3 h-3" />
            View proof {idx + 1}
          </a>
        ))}
        {milestone.proof_hash_sha256 && (
          <div className="flex items-center gap-2 mb-2">
            <p className="text-[10px] text-muted-foreground font-mono">
              Proof hash: {shortAddress(milestone.proof_hash_sha256, 10)}
            </p>
            <CopyButton text={milestone.proof_hash_sha256} />
          </div>
        )}
        {milestone.proof_anchor_tx && (
          <div className="flex items-center gap-2 mb-2">
            <p className="text-[10px] text-muted-foreground font-mono">
              Anchor tx: {shortAddress(milestone.proof_anchor_tx, 10)}
            </p>
            <CopyButton text={milestone.proof_anchor_tx} />
          </div>
        )}
        {milestone.proof_rejection_reason && (
          <p className="text-xs text-yellow-300/90 mb-3">
            Proof feedback: {milestone.proof_rejection_reason}
          </p>
        )}
        {latestAiCheck && (
          <div className={cn("mb-3 rounded-md border p-3 text-xs space-y-1", aiVerdictTone)}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold uppercase tracking-wider">
                Tradeos Agent Check: {latestAiCheck.verdict ?? "caution"}
              </p>
              <p className="text-[10px] opacity-80">
                {latestAiCheck.confidence == null
                  ? "Confidence n/a"
                  : `Confidence ${(latestAiCheck.confidence * 100).toFixed(0)}%`}
              </p>
            </div>
            <p>{latestAiCheck.summary}</p>
            {Array.isArray(aiFindings?.risk_flags) && aiFindings.risk_flags.length > 0 && (
              <p>
                Risk flags: {aiFindings.risk_flags.slice(0, 3).join(" • ")}
              </p>
            )}
            {Array.isArray(aiFindings?.missing_documents) && aiFindings.missing_documents.length > 0 && (
              <p>
                Missing docs: {aiFindings.missing_documents.slice(0, 3).join(" • ")}
              </p>
            )}
            <p className="text-[10px] opacity-80">
              Checked {formatDate(latestAiCheck.created_at)}
            </p>
          </div>
        )}
        {isSupplier && milestone.status === "pending" && !canUploadProof && (
          <p className="text-xs text-muted-foreground mb-3">
            Upload is locked until previous milestone is released.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {isSupplier && milestone.status === "pending" && canUploadProof && (
              <>
                {showProofInput ? (
                  <div className="flex items-center gap-2 w-full">
                    <Input
                      type="file"
                      multiple
                      accept=".pdf,image/png,image/jpeg,image/webp"
                      onChange={(e) =>
                        setProofFiles(Array.from(e.target.files ?? []))
                      }
                      className="bg-input border-border text-xs h-8 flex-1 file:mr-2 file:text-xs"
                    />
                    <Button
                      size="sm"
                      onClick={() => {
                        if (proofFiles.length > 0) {
                          onProofUpload(milestone.milestone_number, proofFiles);
                          setShowProofInput(false);
                          setProofFiles([]);
                        }
                      }}
                      disabled={actionLoading || isUploadingThisMilestone || proofFiles.length === 0}
                      className="h-8 text-xs gradient-gold text-black font-semibold hover:opacity-90"
                    >
                      {isUploadingThisMilestone ? (
                        <>
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        "Submit"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setShowProofInput(false);
                        setProofFiles([]);
                      }}
                      className="h-8 text-xs"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => setShowProofInput(true)}
                    disabled={actionLoading || isUploadingThisMilestone}
                    className="h-7 text-xs gradient-gold text-black font-semibold hover:opacity-90"
                  >
                    {isUploadingThisMilestone ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <Upload className="w-3 h-3 mr-1" />
                    )}
                    {isUploadingThisMilestone ? "Uploading..." : "Upload Proof"}
                  </Button>
                )}
              </>
            )}

          {isBuyer && milestone.status === "proof_uploaded" && (
            <>
              <Button
                size="sm"
                onClick={() => onRelease(milestone.milestone_number)}
                disabled={actionLoading}
                className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white font-semibold"
              >
                <Unlock className="w-3 h-3 mr-1" />
                Approve and Release
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRejectProof(milestone.milestone_number)}
                disabled={actionLoading || isRejectingThisMilestone}
                className="h-7 text-xs border-yellow-400/40 text-yellow-400 hover:bg-yellow-400/10"
              >
                {isRejectingThisMilestone ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <AlertTriangle className="w-3 h-3 mr-1" />
                )}
                {isRejectingThisMilestone ? "Rejecting..." : "Reject Proof"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDispute(milestone.milestone_number)}
                disabled={actionLoading}
                className="h-7 text-xs border-red-400/40 text-red-400 hover:bg-red-400/10"
              >
                <AlertTriangle className="w-3 h-3 mr-1" />
                Dispute
              </Button>
              {Boolean(
                canUseAiCheck &&
                (milestone.proofs ?? []).some((p) => (p.file_mime ?? "").startsWith("image/"))
              ) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAiCheck(milestone.milestone_number)}
                  disabled={actionLoading || isAiCheckingThisMilestone}
                  className="h-7 text-xs border-cyan-400/40 text-cyan-300 hover:bg-cyan-500/10"
                >
                  {isAiCheckingThisMilestone ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Bot className="w-3 h-3 mr-1" />
                  )}
                  {isAiCheckingThisMilestone ? "Checking..." : "Agent Check"}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-muted-foreground hover:text-gold transition-colors"
    >
      {copied ? (
        <Check className="w-3 h-3 text-green-400" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  );
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="trade-card glass-panel space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <p className="text-sm font-semibold">{title}</p>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TradeDetailPage
// ---------------------------------------------------------------------------
export default function TradeDetailPage({
  params,
}: {
  params: Promise<{ tradeId: string }>;
}) {
  const { tradeId } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();
  const inviteToken = searchParams.get("invite_token");
  const createdFromIntent = searchParams.get("created") === "1";

  const { user } = usePrivy();
  const { wallets } = useWallets();
  const { trade, loading, error, refetch } = useTradeDetail(
    tradeId,
    inviteToken
  );
  const {
    recordFunding,
    uploadProofFile,
    runMilestoneAiCheck,
    rejectProof,
    recordRelease,
    syncTradeFromChain,
    acceptTrade,
    declineTrade,
    loading: apiLoading,
  } = useTradeActions();
  const {
    handleFundEscrow,
    handleReleaseMilestone,
    walletReady,
    loading: chainLoading,
  } = useEscrow();

  const walletAddress = useMemo(() => {
    const allWallets = wallets as Array<{
      address?: string;
      walletClientType?: string;
    }>;
    const embedded = allWallets.find(
      (w) => w.walletClientType === "privy" && !!w.address
    );
    const fallback = allWallets.find((w) => !!w.address);

    return (
      embedded?.address ??
      fallback?.address ??
      user?.wallet?.address ??
      user?.linkedAccounts?.find((a) => a.type === "wallet")?.address ??
      null
    );
  }, [wallets, user]);

  const isBuyer = trade?.buyer?.wallet_address === walletAddress;
  const isSupplier = trade?.supplier?.wallet_address === walletAddress;
  const isInviteViewer = !!inviteToken && !isBuyer && !isSupplier;
  const isMember = Boolean(isBuyer || isSupplier);
  const canUseAiCheck = true;
  const actionLoading = apiLoading || chainLoading;
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingMilestone, setUploadingMilestone] = useState<number | null>(null);
  const [rejectingMilestone, setRejectingMilestone] = useState<number | null>(null);
  const [aiCheckingMilestone, setAiCheckingMilestone] = useState<number | null>(null);
  const [fundConfirmOpen, setFundConfirmOpen] = useState(false);
  const [fundRiskAcknowledged, setFundRiskAcknowledged] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectTargetMilestone, setRejectTargetMilestone] = useState<number | null>(null);

  const previousStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!trade) return;
    const previousStatus = previousStatusRef.current;
    if (
      isBuyer &&
      previousStatus === "pending_supplier" &&
      trade.status === "pending_funding"
    ) {
      toast.success("Supplier joined. You can fund escrow now.");
    }
    previousStatusRef.current = trade.status;
  }, [trade, isBuyer]);

  // ---------------------------------------------------------------------------
  // FIX: stable polling — use a ref to hold the latest refetch so the
  // interval is NOT re-created on every render.
  //
  // The original code had `refetch` in the useEffect dependency array.
  // If useTradeDetail returns a new `refetch` reference each render (which
  // is the default when not wrapped in useCallback inside the hook), the
  // effect fires on every render, clearing and re-creating the interval
  // constantly. That caused the continuous "full refresh" experience.
  //
  // The ref pattern below keeps the interval stable for the entire life of
  // the "pending" stages without requiring a change inside useTradeDetail.
  // ---------------------------------------------------------------------------
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  const tradeStatus = trade?.status ?? null;
  const shouldPollTrade =
    Boolean(isBuyer || isSupplier) &&
    !["completed", "cancelled", "refunded"].includes(tradeStatus ?? "");

  useEffect(() => {
    if (!shouldPollTrade) return;

    const timer = setInterval(() => {
      // Always calls the latest refetch without putting it in deps
      refetchRef.current();
    }, 8_000);

    return () => clearInterval(timer);
  }, [shouldPollTrade]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  const statusLabel = trade
    ? TRADE_STATUS_LABELS[trade.status] ?? trade.status
    : "";
  const statusColor = trade
    ? TRADE_STATUS_COLORS[trade.status] ?? "text-muted-foreground"
    : "";

  const inviteLink = useMemo(
    () => trade?.supplier_invite_link ?? null,
    [trade]
  );

  const nextActor = useMemo(() => {
    if (!trade) return "-";
    if (trade.status === "pending_supplier") return "Supplier";
    if (trade.status === "pending_funding") return "Buyer";
    if (
      [
        "funded",
        "in_progress",
        "milestone_1_released",
        "milestone_2_released",
      ].includes(trade.status)
    )
      return "Supplier / Buyer";
    if (trade.status === "disputed") return "Arbiter";
    return "None";
  }, [trade]);

  const copyInviteLink = useCallback(async () => {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    toast.success("Supplier invite link copied");
  }, [inviteLink]);

  const onAcceptTrade = useCallback(async () => {
    if (!trade || !inviteToken) return;
    try {
      await acceptTrade(trade.id, inviteToken);
      router.replace(`/trades/${trade.id}`);
      await refetch();
    } catch {
      // handled by hook toast
    }
  }, [trade, inviteToken, acceptTrade, router, refetch]);

  const onDeclineTrade = useCallback(async () => {
    if (!trade || !inviteToken) return;
    try {
      await declineTrade(trade.id, inviteToken);
      router.replace("/trades");
    } catch {
      // handled by hook toast
    }
  }, [trade, inviteToken, declineTrade, router]);

  const onFundEscrow = useCallback(async () => {
    if (!trade) return;
    try {
      const { fundTx, escrowPubkey } = await handleFundEscrow(trade);
      await recordFunding(trade.id, escrowPubkey, fundTx);
      setFundConfirmOpen(false);
      setFundRiskAcknowledged(false);
      refetch();
    } catch {
      // handled by useEscrow toast
    }
  }, [trade, handleFundEscrow, recordFunding, refetch]);

  const onRelease = useCallback(
    async (milestoneNumber: number) => {
      if (!trade) return;
      try {
        const tx = await handleReleaseMilestone(trade, milestoneNumber - 1);
        await recordRelease(trade.id, milestoneNumber, tx);
        refetch();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isOutOfOrder =
          message.includes("MilestoneOutOfOrder") ||
          message.includes("Milestones must be released in order");
        if (isOutOfOrder) {
          try {
            const sync = await syncTradeFromChain(trade.id);
            await refetch();
            if (sync.next_milestone_number) {
              toast(
                `Trade synced from chain. Next milestone is ${sync.next_milestone_number}.`
              );
            } else {
              toast("Trade synced from chain.");
            }
          } catch {
            // syncTradeFromChain already toasts its own error
          }
        }
      }
    },
    [trade, handleReleaseMilestone, recordRelease, syncTradeFromChain, refetch]
  );

  const onDispute = useCallback(
    (milestoneNumber: number) => {
      if (!trade) return;
      router.push(`/trades/${trade.id}/dispute?milestone=${milestoneNumber}`);
    },
    [trade, router]
  );

  const onRejectProof = useCallback(
    (milestoneNumber: number) => {
      setRejectTargetMilestone(milestoneNumber);
      setRejectReason("");
      setRejectDialogOpen(true);
    },
    []
  );

  const onConfirmRejectProof = useCallback(async () => {
    if (!trade || !rejectTargetMilestone) return;
    const reason = rejectReason.trim();
    if (!reason) {
      toast.error("Please provide a rejection reason.");
      return;
    }
    setRejectingMilestone(rejectTargetMilestone);
    try {
      await rejectProof(trade.id, rejectTargetMilestone, reason);
      setRejectDialogOpen(false);
      setRejectReason("");
      setRejectTargetMilestone(null);
      await refetch();
    } finally {
      setRejectingMilestone(null);
    }
  }, [trade, rejectTargetMilestone, rejectReason, rejectProof, refetch]);

  const onProofUpload = useCallback(
    async (milestoneNumber: number, files: File[]) => {
      if (!trade) return;
      setUploadingMilestone(milestoneNumber);
      try {
        await uploadProofFile(trade.id, milestoneNumber, files);
        await refetch();
      } finally {
        setUploadingMilestone(null);
      }
    },
    [trade, uploadProofFile, refetch]
  );

  const onAiCheck = useCallback(
    async (milestoneNumber: number) => {
      if (!trade) return;
      setAiCheckingMilestone(milestoneNumber);
      try {
        const res = await runMilestoneAiCheck(trade.id, milestoneNumber);
        toast.success(`Agent check: ${res.verdict}`);
        await refetch();
      } finally {
        setAiCheckingMilestone(null);
      }
    },
    [trade, runMilestoneAiCheck, refetch]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="max-w-2xl space-y-6 animate-fade-in">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (error || !trade) {
    if ((error ?? "").toLowerCase().includes("forbidden")) {
      router.replace("/forbidden");
      return null;
    }
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground text-sm">
          {error ?? "Trade not found"}
        </p>
        <Link
          href="/trades"
          className="text-gold text-sm hover:underline mt-2 inline-block"
        >
          Back to trades
        </Link>
      </div>
    );
  }

  if (isInviteViewer && trade.status === "pending_supplier") {
    return (
      <div className="max-w-3xl animate-fade-in space-y-5">
        <div className="trade-card glass-panel space-y-4">
          <h1 className="text-xl font-semibold text-[#E6D3A3]">Supplier Trade Invitation</h1>
          <p className="text-sm text-muted-foreground">
            Review the core terms below. Accepting binds you to the trade terms and Tradeos platform terms.
          </p>
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Buyer Wallet</p>
              <p className="font-mono mt-1">{shortAddress(trade.buyer?.wallet_address ?? "", 8)}</p>
            </div>
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Trade Value</p>
              <p className="font-mono mt-1 text-[#E6D3A3]">${formatUsdc(Number(trade.total_amount_usdc))} USDC</p>
            </div>
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3 md:col-span-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Trade Description</p>
              <p className="mt-1">{trade.goods_description}</p>
            </div>
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Quantity</p>
              <p className="mt-1">{trade.quantity || "-"}</p>
            </div>
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Corridor</p>
              <p className="mt-1">{trade.corridor}</p>
            </div>
          </div>

          <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Milestones</p>
            <div className="space-y-2">
              {trade.milestones?.map((m) => (
                <div key={m.id} className="flex items-center justify-between text-sm">
                  <p>{m.milestone_number}. {m.description}</p>
                  <p className="font-mono text-[#D4AF6A]">{m.release_percentage}%</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Logistics</p>
              <p>Pickup: {trade.pickup_location || "-"}</p>
              <p>Dropoff: {trade.dropoff_location || "-"}</p>
              <p>Ship Date: {trade.expected_ship_date ? formatDate(trade.expected_ship_date) : "-"}</p>
              <p>Delivery: {trade.expected_delivery_date ? formatDate(trade.expected_delivery_date) : "-"}</p>
            </div>
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Contact Details</p>
              <p>Buyer: {trade.buyer_contact_name || "-"}</p>
              <p>Buyer Phone: {trade.buyer_contact_phone || "-"}</p>
              <p>Supplier Contact: {trade.supplier_contact_name || "-"}</p>
              <p>Supplier Phone: {trade.supplier_contact_phone || "-"}</p>
            </div>
          </div>
          {trade.notes ? (
            <div className="rounded-md border border-[hsl(var(--gold)/0.2)] p-3 text-sm">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Notes</p>
              <p>{trade.notes}</p>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Agreement Notice: By accepting, you agree to fulfill this trade under the listed terms and Tradeos terms, including milestone execution and dispute process.
          </p>
          <div className="flex gap-2">
            <Button onClick={onAcceptTrade} disabled={actionLoading} className="gradient-gold text-black font-semibold hover:opacity-90">
              {actionLoading ? "Processing..." : "Accept Trade Terms"}
            </Button>
            <Button variant="outline" onClick={onDeclineTrade} disabled={actionLoading} className="border-red-400/40 text-red-300 hover:bg-red-500/10">
              Reject
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl animate-fade-in space-y-6">
      <Link
        href="/trades"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All trades
      </Link>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={refreshing}
          className="text-xs"
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </Button>
      </div>

      {createdFromIntent && isBuyer && (
        <div className="trade-card border-[hsl(var(--gold)/0.4)] bg-[hsl(var(--gold)/0.03)] space-y-2">
          <p className="text-sm font-semibold text-gold">Trade intent created</p>
          <p className="text-xs text-muted-foreground">
            Next steps: 1) send supplier invite link, 2) wait for supplier to
            join, 3) fund escrow once status changes to Awaiting Funding.
          </p>
        </div>
      )}

      {/* ── Trade summary card ─────────────────────────────────────────── */}
      <Section title="Trade Summary" defaultOpen={true}>
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-lg font-bold font-mono">
                {trade.trade_number}
              </h1>
              <span className="text-xs text-muted-foreground font-mono">
                {trade.corridor}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {trade.goods_description}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xl font-mono font-bold text-gold">
              ${formatUsdc(Number(trade.total_amount_usdc))}
            </p>
            <p className="text-xs text-muted-foreground">USDC</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Status
            </p>
            <p className={cn("text-sm font-medium", statusColor)}>
              {statusLabel}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Trade ID
            </p>
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-mono text-muted-foreground break-all">
                {trade.id}
              </p>
              <CopyButton text={trade.id} />
            </div>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Next Actor
            </p>
            <p className="text-sm">{nextActor}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Buyer
            </p>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-mono">
                {shortAddress(trade.buyer?.wallet_address ?? "")}
              </p>
              {trade.buyer?.wallet_address && (
                <CopyButton text={trade.buyer.wallet_address} />
              )}
              {isBuyer && (
                <Badge
                  variant="outline"
                  className="text-[9px] text-gold border-gold/30 py-0 h-4"
                >
                  You
                </Badge>
              )}
            </div>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Supplier
            </p>
            {trade.supplier ? (
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-mono">
                  {shortAddress(trade.supplier.wallet_address)}
                </p>
                <CopyButton text={trade.supplier.wallet_address} />
                {isSupplier && (
                  <Badge
                    variant="outline"
                    className="text-[9px] text-gold border-gold/30 py-0 h-4"
                  >
                    You
                  </Badge>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Awaiting supplier
              </p>
            )}
          </div>
        </div>

        {trade.escrow_pubkey && (
          <div className="pt-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Escrow Account
            </p>
            <div className="flex items-center gap-2">
              <p className="text-xs font-mono text-muted-foreground">
                {shortAddress(trade.escrow_pubkey, 8)}
              </p>
              <CopyButton text={trade.escrow_pubkey} />
              <a
                href={solscanAccountUrl(trade.escrow_pubkey)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-muted-foreground hover:text-gold flex items-center gap-0.5 transition-colors"
              >
                <ExternalLink className="w-2.5 h-2.5" /> Solscan
              </a>
            </div>
          </div>
        )}
        {trade.receipt?.receipt_hash && (
          <div className="pt-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Receipt Hash
            </p>
            <div className="flex items-center gap-2">
              <p className="text-xs font-mono text-muted-foreground">
                {shortAddress(trade.receipt.receipt_hash, 10)}
              </p>
              <CopyButton text={trade.receipt.receipt_hash} />
            </div>
          </div>
        )}
      </div>
      </Section>

      {trade.corridor_intelligence && (
        <Section title="Corridor Intelligence" defaultOpen={false}>
          <div className="space-y-3 text-xs">
            <p className="text-muted-foreground">
              Guidance only. Recommended docs by stage for {trade.corridor_intelligence.corridor} /{" "}
              {trade.corridor_intelligence.commodity_type}. Not enforced.
            </p>
            <div className="space-y-2">
              {trade.corridor_intelligence.required_document_pack_rules.map((rule) => (
                <div key={rule.stage} className="rounded-md border border-border p-3">
                  <p className="font-semibold">{rule.label}</p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{rule.stage.replace("_", " ")}</p>
                  <p className="mt-1">{rule.recommended_documents.join(" • ")}</p>
                  {rule.notes ? <p className="mt-1 text-muted-foreground">{rule.notes}</p> : null}
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* ── Trade timeline ─────────────────────────────────────────────── */}
      <div className="trade-card space-y-2">
        <p className="text-sm font-semibold">Trade Timeline</p>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {(
            [
              {
                label: "1. Intent Created",
                active: [
                  "pending_supplier",
                  "pending_funding",
                  "funded",
                  "in_progress",
                  "milestone_1_released",
                  "milestone_2_released",
                  "completed",
                  "disputed",
                ],
              },
              {
                label: "2. Supplier Joined",
                active: [
                  "pending_funding",
                  "funded",
                  "in_progress",
                  "milestone_1_released",
                  "milestone_2_released",
                  "completed",
                  "disputed",
                ],
              },
              {
                label: "3. Awaiting Funding",
                active: ["pending_funding"],
              },
              {
                label: "4. Escrow Funded",
                active: [
                  "funded",
                  "in_progress",
                  "milestone_1_released",
                  "milestone_2_released",
                  "completed",
                  "disputed",
                ],
              },
            ] as const
          ).map(({ label, active }) => (
            <div
              key={label}
              className={cn(
                "rounded-md border px-2 py-1",
                (active as readonly string[]).includes(trade.status)
                  ? "border-gold/40 text-gold"
                  : "border-border text-muted-foreground"
              )}
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* ── Invite supplier ────────────────────────────────────────────── */}
      {isBuyer && trade.status === "pending_supplier" && (
        <div className="trade-card border-[hsl(var(--gold)/0.35)] bg-[hsl(var(--gold)/0.03)] space-y-3">
          <p className="text-sm font-semibold">Invite Supplier</p>
          <p className="text-xs text-muted-foreground">
            Share this link with your supplier. This page checks for their
            response every 20 s and will update automatically when they join.
          </p>
          <div className="rounded-md border border-border bg-input/40 px-3 py-2 text-xs font-mono break-all">
            {inviteLink ?? "Invite link not available"}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              type="button"
              size="sm"
              onClick={copyInviteLink}
              disabled={!inviteLink}
              className="gradient-gold text-black font-semibold hover:opacity-90"
            >
              <Copy className="w-3.5 h-3.5 mr-1" />
              Copy Invite Link
            </Button>
            {inviteLink && (
              <Button type="button" size="sm" variant="outline" asChild>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(inviteLink)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Send via WhatsApp
                </a>
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Supplier status: {trade.supplier ? "Joined ✓" : "Not joined yet"}
          </p>
        </div>
      )}

      {/* ── Supplier invitation (invite viewer) ────────────────────────── */}
      {/* ── Fund escrow CTA ────────────────────────────────────────────── */}
      {isBuyer && trade.status === "pending_funding" && (
        <>
          {trade.counterparty_risk_signals && (
            <div className="trade-card border-[hsl(var(--gold)/0.25)] bg-[hsl(var(--gold)/0.03)] space-y-3">
              <p className="text-sm font-semibold">Counterparty Risk Signals (Pre-Funding)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-md border border-border p-3 space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Counterparty Reliability</p>
                  <p className="text-base font-semibold">
                    {trade.counterparty_risk_signals.counterparty.reliabilityScore}/100
                  </p>
                  <p>Tier: <span className="font-semibold">{trade.counterparty_risk_signals.counterparty.reliabilityTier}</span></p>
                  <p>Dispute incidence: {(trade.counterparty_risk_signals.counterparty.disputeIncidence * 100).toFixed(1)}%</p>
                  <p>
                    Median proof-to-release:{" "}
                    {trade.counterparty_risk_signals.counterparty.medianProofToReleaseHours == null
                      ? "n/a"
                      : `${trade.counterparty_risk_signals.counterparty.medianProofToReleaseHours.toFixed(1)}h`}
                  </p>
                </div>
                <div className="rounded-md border border-border p-3 space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Route Risk ({trade.counterparty_risk_signals.route.corridor})
                  </p>
                  <p className="text-base font-semibold">
                    {trade.counterparty_risk_signals.route.routeRiskScore}/100
                  </p>
                  <p>Tier: <span className="font-semibold">{trade.counterparty_risk_signals.route.routeRiskTier}</span></p>
                  <p>Dispute incidence: {(trade.counterparty_risk_signals.route.disputeIncidence * 100).toFixed(1)}%</p>
                  <p>
                    Median proof-to-release:{" "}
                    {trade.counterparty_risk_signals.route.medianProofToReleaseHours == null
                      ? "n/a"
                      : `${trade.counterparty_risk_signals.route.medianProofToReleaseHours.toFixed(1)}h`}
                  </p>
                </div>
              </div>
            </div>
          )}
          <div className="trade-card border-[hsl(var(--gold)/0.4)] bg-[hsl(var(--gold)/0.03)] space-y-3">
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-gold" />
              <p className="text-sm font-semibold">Fund the Escrow</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Connect your buyer wallet with enough devnet USDC, then lock $
              {formatUsdc(Number(trade.total_amount_usdc))} USDC into escrow.
              Funds release by milestones.
            </p>
            <Button
              onClick={() => setFundConfirmOpen(true)}
              disabled={actionLoading}
              className="gradient-gold text-black font-semibold hover:opacity-90 glow-gold"
            >
              <Lock className="w-4 h-4 mr-2" />
              {actionLoading
                ? "Processing..."
                : `Lock $${formatUsdc(Number(trade.total_amount_usdc))} USDC`}
            </Button>
          </div>
        </>
      )}

      {fundConfirmOpen && isBuyer && trade.status === "pending_funding" && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-popover p-4 space-y-4">
            <h3 className="text-sm font-semibold">Confirm Escrow Funding</h3>
            <p className="text-xs text-muted-foreground">
              Review risk signals before locking funds. This snapshot is recorded at funding time.
            </p>
            {trade.counterparty_risk_signals ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-md border border-border p-3 space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Counterparty</p>
                  <p>Reliability: <span className="font-semibold">{trade.counterparty_risk_signals.counterparty.reliabilityScore}/100 ({trade.counterparty_risk_signals.counterparty.reliabilityTier})</span></p>
                  <p>Dispute incidence: {(trade.counterparty_risk_signals.counterparty.disputeIncidence * 100).toFixed(1)}%</p>
                  <p>Median proof-to-release: {trade.counterparty_risk_signals.counterparty.medianProofToReleaseHours == null ? "n/a" : `${trade.counterparty_risk_signals.counterparty.medianProofToReleaseHours.toFixed(1)}h`}</p>
                </div>
                <div className="rounded-md border border-border p-3 space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Route ({trade.counterparty_risk_signals.route.corridor})</p>
                  <p>Risk: <span className="font-semibold">{trade.counterparty_risk_signals.route.routeRiskScore}/100 ({trade.counterparty_risk_signals.route.routeRiskTier})</span></p>
                  <p>Dispute incidence: {(trade.counterparty_risk_signals.route.disputeIncidence * 100).toFixed(1)}%</p>
                  <p>Median proof-to-release: {trade.counterparty_risk_signals.route.medianProofToReleaseHours == null ? "n/a" : `${trade.counterparty_risk_signals.route.medianProofToReleaseHours.toFixed(1)}h`}</p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Risk signals unavailable for this trade.</p>
            )}
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={fundRiskAcknowledged}
                onChange={(e) => setFundRiskAcknowledged(e.target.checked)}
              />
              <span>I acknowledge these risk signals and want to proceed with funding.</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (actionLoading) return;
                  setFundConfirmOpen(false);
                  setFundRiskAcknowledged(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={onFundEscrow}
                disabled={actionLoading || !fundRiskAcknowledged}
                className="gradient-gold text-black font-semibold hover:opacity-90"
              >
                {actionLoading ? "Processing..." : `Fund $${formatUsdc(Number(trade.total_amount_usdc))} USDC`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Milestones ─────────────────────────────────────────────────── */}
      <Section title="Milestones" defaultOpen={true}>
      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Milestones
        </h2>
        {trade.milestones && trade.milestones.length > 0 ? (
          <div>
            {trade.milestones.map((milestone) => (
                <MilestoneStep
                  key={milestone.id}
                  milestone={milestone}
                  trade={trade}
                  isBuyer={isBuyer}
                  isSupplier={isSupplier}
                  onProofUpload={onProofUpload}
                  onRelease={onRelease}
                  onDispute={onDispute}
                  onRejectProof={onRejectProof}
                  onAiCheck={onAiCheck}
                  actionLoading={actionLoading}
                  isUploadingThisMilestone={uploadingMilestone === milestone.milestone_number}
                  isRejectingThisMilestone={rejectingMilestone === milestone.milestone_number}
                  isAiCheckingThisMilestone={aiCheckingMilestone === milestone.milestone_number}
                  canUploadProof={
                    trade.milestones?.find((m) => m.status !== "released")?.milestone_number ===
                      milestone.milestone_number &&
                    [
                      "funded",
                      "in_progress",
                      "milestone_1_released",
                      "milestone_2_released",
                    ].includes(trade.status)
                  }
                  canUseAiCheck={canUseAiCheck}
                />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No milestones found.</p>
        )}
      </div>
      </Section>

      {rejectDialogOpen && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-4 space-y-3">
            <h3 className="text-sm font-semibold">Reject Proof</h3>
            <p className="text-xs text-muted-foreground">
              Explain why you are rejecting this proof. The supplier will see this feedback.
            </p>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection..."
              className="min-h-24"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (rejectingMilestone != null) return;
                  setRejectDialogOpen(false);
                  setRejectReason("");
                  setRejectTargetMilestone(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={onConfirmRejectProof}
                disabled={rejectingMilestone != null}
                className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold"
              >
                {rejectingMilestone != null ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                    Rejecting...
                  </>
                ) : (
                  "Submit Rejection"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Trade chat ─────────────────────────────────────────────────── */}
      {isMember && (
        <TradeChat
          tradeId={trade.id}
          isClosed={["completed", "cancelled", "refunded"].includes(trade.status)}
        />
      )}

    </div>
  );
}
