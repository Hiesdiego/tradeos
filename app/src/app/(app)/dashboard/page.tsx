//tradeos/app/src/app/(app)/dashboard/page.tsx

"use client";

import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import Link from "next/link";
import {
  ArrowRight,
  ArrowLeftRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
  PlusCircle,
  TrendingUp,
  TrendingDown,
  Download,
  Wallet,
  Landmark,
  Scale,
} from "lucide-react";
import { useTrades } from "@/hooks/useTrade";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatUsdc,
  shortAddress,
  formatDate,
  solscanAccountUrl,
} from "@/lib/utils";
import {
  TRADE_STATUS_LABELS,
  TRADE_STATUS_COLORS,
} from "@/lib/constants";
import type { Trade } from "@/types";

type DashboardView = "all" | "buyer" | "supplier" | "actionable" | "disputed";

function readStoredDashboardView(): DashboardView {
  if (typeof window === "undefined") return "all";
  const stored = window.localStorage.getItem("dashboard_view");
  return stored === "all" ||
    stored === "buyer" ||
    stored === "supplier" ||
    stored === "actionable" ||
    stored === "disputed"
    ? stored
    : "all";
}

function StatCard({
  label,
  value,
  icon: Icon,
  sub,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  sub?: string;
}) {
  return (
    <div className="trade-card glass-panel flex items-start justify-between">
      <div>
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        <p className="text-2xl font-bold font-mono">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </div>
      <div className="w-9 h-9 rounded-md bg-[hsl(var(--gold)/0.1)] border border-[hsl(var(--gold)/0.2)] flex items-center justify-center">
        <Icon className="w-4 h-4 text-gold" />
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: Trade }) {
  const isBuyer = true; // will refine with user context
  const statusLabel = TRADE_STATUS_LABELS[trade.status] ?? trade.status;
  const statusColor = TRADE_STATUS_COLORS[trade.status] ?? "text-muted-foreground";
  const pendingMilestone = trade.milestones?.find(
    (m) => m.status === "proof_uploaded"
  );

  return (
    <Link
      href={`/trades/${trade.id}`}
      className="flex items-center justify-between px-4 py-3 rounded-md border border-border hover:border-[hsl(var(--gold)/0.3)] hover:bg-secondary/30 transition-all duration-150 group"
    >
      <div className="flex items-center gap-4">
        <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center flex-shrink-0">
          <ArrowLeftRight className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold font-mono">
              {trade.trade_number}
            </span>
            {pendingMilestone && (
              <Badge variant="outline" className="text-[10px] text-gold border-gold/40 py-0">
                Action needed
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate max-w-xs mt-0.5">
            {trade.goods_description}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="text-right hidden sm:block">
          <p className="text-sm font-mono font-semibold">
            ${formatUsdc(Number(trade.total_amount_usdc))}
          </p>
          <p className="text-[10px] text-muted-foreground">USDC</p>
        </div>
        <div className="text-right hidden md:block">
          <p className={`text-xs font-medium ${statusColor}`}>{statusLabel}</p>
          <p className="text-[10px] text-muted-foreground">
            {formatDate(trade.created_at)}
          </p>
        </div>
        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-gold transition-colors" />
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const { user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { trades, loading } = useTrades();
  const [risk, setRisk] = useState<{
    my_risk?: { score: number; tier: "low" | "medium" | "high" };
    counterparties?: Array<{
      user_id: string;
      wallet_address: string;
      display_name: string | null;
      score: number;
      tier: "low" | "medium" | "high";
    }>;
  } | null>(null);
  const [health, setHealth] = useState<{ ok: boolean } | null>(null);
  const [view, setView] = useState<DashboardView>(readStoredDashboardView);

  const walletAddress = useMemo(
    () =>
      wallets[0]?.address ??
      user?.wallet?.address ??
      user?.linkedAccounts?.find((a) => a.type === "wallet")?.address ??
      null,
    [wallets, user]
  );

  const activeTrades = trades.filter(
    (t) =>
      !["completed", "cancelled", "refunded"].includes(t.status)
  );
  const pendingAction = trades.filter(
    (t) =>
      t.milestones?.some((m) => m.status === "proof_uploaded") ||
      t.status === "pending_funding"
  );
  const totalEscrowed = trades.reduce((sum, trade) => {
    const statusHasLockedEscrow = [
      "funded",
      "in_progress",
      "milestone_1_released",
      "milestone_2_released",
      "disputed",
    ].includes(trade.status);

    if (!statusHasLockedEscrow) {
      return sum;
    }

    const releasedAmount =
      trade.milestones?.reduce((releasedSum, milestone) => {
        if (milestone.status !== "released") return releasedSum;
        return (
          releasedSum +
          (Number(trade.total_amount_usdc) * milestone.release_percentage) / 100
        );
      }, 0) ?? 0;

    const lockedAmount = Math.max(
      0,
      Number(trade.total_amount_usdc) - releasedAmount
    );
    return sum + lockedAmount;
  }, 0);
  const completedTrades = trades.filter((t) => t.status === "completed");
  const settledVolume = trades
    .filter((t) => ["completed", "in_progress", "milestone_1_released", "milestone_2_released"].includes(t.status))
    .reduce((sum, t) => sum + Number(t.total_amount_usdc), 0);
  const disputedExposure = trades
    .filter((t) => t.status === "disputed")
    .reduce((sum, t) => sum + Number(t.total_amount_usdc), 0);
  const refundedVolume = trades
    .filter((t) => t.status === "refunded")
    .reduce((sum, t) => sum + Number(t.total_amount_usdc), 0);
  const releasedVolume = trades.reduce((sum, trade) => {
    const released =
      trade.milestones?.reduce((acc, m) => {
        if (m.status !== "released") return acc;
        return acc + (Number(trade.total_amount_usdc) * m.release_percentage) / 100;
      }, 0) ?? 0;
    return sum + released;
  }, 0);
  const netRealizedFlow = releasedVolume - refundedVolume;
  const avgDaysToRelease = (() => {
    const values = trades.flatMap((trade) =>
      (trade.milestones ?? [])
        .filter((m) => m.released_at)
        .map((m) => {
          const created = new Date(trade.created_at).getTime();
          const released = new Date(m.released_at as string).getTime();
          if (!Number.isFinite(created) || !Number.isFinite(released)) return null;
          const days = (released - created) / (1000 * 60 * 60 * 24);
          return days >= 0 ? days : null;
        })
        .filter((v): v is number => v != null)
    );
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  })();

  const displayName =
    user?.email?.address?.split("@")[0] ?? "Merchant";

  const filteredTrades = useMemo(() => {
    const mine = trades.filter((t) => {
      const isBuyer = walletAddress != null && t.buyer?.wallet_address === walletAddress;
      const isSupplier = walletAddress != null && t.supplier?.wallet_address === walletAddress;
      if (view === "buyer") return isBuyer;
      if (view === "supplier") return isSupplier;
      if (view === "actionable") {
        return (
          (isBuyer &&
            (t.status === "pending_funding" ||
              t.milestones?.some((m) => m.status === "proof_uploaded"))) ||
          (isSupplier &&
            (t.status === "pending_supplier" ||
              t.milestones?.some((m) => m.status === "pending")))
        );
      }
      if (view === "disputed") return t.status === "disputed";
      return true;
    });
    return mine;
  }, [trades, view, walletAddress]);

  const actionQueue = useMemo(() => {
    return filteredTrades
      .map((t) => {
        const isBuyer = walletAddress != null && t.buyer?.wallet_address === walletAddress;
        const isSupplier = walletAddress != null && t.supplier?.wallet_address === walletAddress;
        if (isBuyer && t.status === "pending_funding") {
          return { trade: t, label: "Fund escrow", href: `/trades/${t.id}` };
        }
        if (isBuyer && t.milestones?.some((m) => m.status === "proof_uploaded")) {
          return { trade: t, label: "Approve milestone proof", href: `/trades/${t.id}` };
        }
        if (isSupplier && t.status === "pending_supplier") {
          return { trade: t, label: "Awaiting acceptance flow", href: `/trades/${t.id}` };
        }
        return null;
      })
      .filter((v): v is { trade: Trade; label: string; href: string } => v != null)
      .slice(0, 5);
  }, [filteredTrades, walletAddress]);

  const cashflowTimeline = useMemo(() => {
    return filteredTrades
      .flatMap((t) =>
        (t.milestones ?? []).map((m) => ({
          id: `${t.id}-${m.id}`,
          tradeId: t.id,
          tradeNumber: t.trade_number,
          milestone: m.milestone_number,
          status: m.status,
          amount: (Number(t.total_amount_usdc) * m.release_percentage) / 100,
        }))
      )
      .filter((x) => x.status !== "released")
      .slice(0, 8);
  }, [filteredTrades]);

  const alerts = useMemo(() => {
    const out: Array<{ id: string; level: "high" | "medium" | "low"; message: string; href?: string }> = [];
    if (health && !health.ok) {
      out.push({ id: "health", level: "high", message: "System health degraded. Check /api/health." });
    }
    for (const t of filteredTrades) {
      if (t.status === "disputed") {
        out.push({ id: `disp-${t.id}`, level: "high", message: `${t.trade_number} is disputed`, href: `/trades/${t.id}` });
      }
      if (t.status === "funded" && !t.escrow_pubkey) {
        out.push({ id: `sync-${t.id}`, level: "high", message: `${t.trade_number} funded but escrow key missing`, href: `/trades/${t.id}` });
      }
      if (t.milestones?.some((m) => !!m.proof_rejection_reason)) {
        out.push({ id: `proof-${t.id}`, level: "medium", message: `${t.trade_number} has rejected proof feedback`, href: `/trades/${t.id}` });
      }
      if (t.status === "pending_supplier") {
        out.push({ id: `invite-${t.id}`, level: "low", message: `${t.trade_number} is waiting for supplier response`, href: `/trades/${t.id}` });
      }
    }
    return out.slice(0, 8);
  }, [filteredTrades, health]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/treasury/risk", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setRisk(data);
      } catch {
        // noop
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  useEffect(() => {
    window.localStorage.setItem("dashboard_view", view);
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (!cancelled) setHealth({ ok: Boolean(data?.ok) });
      } catch {
        if (!cancelled) setHealth({ ok: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function exportTreasuryCsv() {
    const token = await getAccessToken();
    if (!token) return;

    const res = await fetch("/api/treasury/export", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tradeos_treasury_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5 sm:space-y-6 md:space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold leading-tight">
            Welcome back,{" "}
            <span className="text-gold">{displayName}</span>
          </h1>
          <p className="text-muted-foreground text-xs sm:text-sm mt-1">
            West Africa {"<->"} UAE Corridor
          </p>
        </div>
        <Button
          asChild
          className="gradient-gold text-black font-semibold text-sm hover:opacity-90 glow-gold"
        >
          <Link href="/trades/new">
            <PlusCircle className="w-4 h-4 mr-2" />
            New Trade
          </Link>
        </Button>
      </div>
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={exportTreasuryCsv}
          className="text-xs"
        >
          <Download className="w-3 h-3 mr-1.5" />
          Export Treasury CSV
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(["all", "buyer", "supplier", "actionable", "disputed"] as const).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant={view === mode ? "default" : "outline"}
            className={view === mode ? "gradient-gold text-black" : "text-xs"}
            onClick={() => setView(mode)}
          >
            {mode}
          </Button>
        ))}
      </div>
      {risk?.my_risk && (
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" className="border-red-400/30">
            Anti-Fraud Score: {risk.my_risk.score}/100
          </Badge>
          <Badge
            variant="outline"
            className={
              risk.my_risk.tier === "high"
                ? "border-red-400/40 text-red-300"
                : risk.my_risk.tier === "medium"
                ? "border-yellow-400/40 text-yellow-300"
                : "border-green-400/40 text-green-300"
            }
          >
            Risk Tier: {risk.my_risk.tier}
          </Badge>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="trade-card">
          <h3 className="text-sm font-semibold mb-2">Action Queue</h3>
          {actionQueue.length === 0 ? (
            <p className="text-xs text-muted-foreground">No immediate actions.</p>
          ) : (
            <div className="space-y-2">
              {actionQueue.map((item) => (
                <Link key={item.trade.id} href={item.href} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs hover:border-[hsl(var(--gold)/0.3)]">
                  <span>{item.trade.trade_number}: {item.label}</span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="trade-card">
          <h3 className="text-sm font-semibold mb-2">Escrow/Chain Status</h3>
          <div className="space-y-2 text-xs">
            <p>
              API Health:{" "}
              <span className={health?.ok ? "text-green-300" : "text-red-300"}>
                {health?.ok ? "healthy" : "degraded"}
              </span>
            </p>
            <p>
              Synced Escrows:{" "}
              <span className="font-mono">
                {filteredTrades.filter((t) => !["pending_supplier", "pending_funding"].includes(t.status) && !!t.escrow_pubkey).length}/
                {filteredTrades.filter((t) => !["pending_supplier", "pending_funding"].includes(t.status)).length}
              </span>
            </p>
            <p className="text-muted-foreground">
              Trades with escrow key and funded/progress statuses are treated as chain-linked.
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))
        ) : (
          <>
            <StatCard
              label="Active Trades"
              value={activeTrades.length}
              icon={ArrowLeftRight}
              sub="in progress"
            />
            <StatCard
              label="In Escrow"
              value={`$${formatUsdc(totalEscrowed)}`}
              icon={Wallet}
              sub="USDC locked"
            />
            <StatCard
              label="Pending Action"
              value={pendingAction.length}
              icon={Clock}
              sub="need your review"
            />
            <StatCard
              label="Completed"
              value={completedTrades.length}
              icon={CheckCircle2}
              sub="all time"
            />
          </>
        )}
      </div>
      <div className="trade-card glass-panel">
        <h3 className="text-sm font-semibold mb-2 text-[#E6D3A3]">How to read this dashboard</h3>
        <p className="text-xs text-muted-foreground">
          `In Escrow` is currently locked capital. `Released to Suppliers` tracks payout progress.
          `Disputed Exposure` shows value in disputes. This gives advanced treasury visibility without requiring finance expertise.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="trade-card">
          <h3 className="text-sm font-semibold mb-2">Counterparty Risk Snapshot</h3>
          {risk?.counterparties?.length ? (
            <div className="space-y-2">
              {risk.counterparties.slice(0, 6).map((cp) => (
                <div key={cp.user_id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs">
                  <span>{cp.display_name ?? shortAddress(cp.wallet_address)}</span>
                  <span className={cp.tier === "high" ? "text-red-300" : cp.tier === "medium" ? "text-yellow-300" : "text-green-300"}>
                    {cp.tier} ({cp.score})
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No counterparty risk data yet.</p>
          )}
        </div>
        <div className="trade-card">
          <h3 className="text-sm font-semibold mb-2">Operations Alerts</h3>
          {alerts.length ? (
            <div className="space-y-2">
              {alerts.map((a) =>
                a.href ? (
                  <Link key={a.id} href={a.href} className="block rounded-md border border-border px-3 py-2 text-xs hover:border-[hsl(var(--gold)/0.3)]">
                    <span className={a.level === "high" ? "text-red-300" : a.level === "medium" ? "text-yellow-300" : "text-muted-foreground"}>[{a.level}]</span>{" "}
                    {a.message}
                  </Link>
                ) : (
                  <div key={a.id} className="rounded-md border border-border px-3 py-2 text-xs">
                    <span className={a.level === "high" ? "text-red-300" : a.level === "medium" ? "text-yellow-300" : "text-muted-foreground"}>[{a.level}]</span>{" "}
                    {a.message}
                  </div>
                )
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No alerts.</p>
          )}
        </div>
      </div>
      <div className="trade-card">
        <h3 className="text-sm font-semibold mb-2">Cashflow Timeline</h3>
        {cashflowTimeline.length ? (
          <div className="space-y-2">
            {cashflowTimeline.map((row) => (
              <Link key={row.id} href={`/trades/${row.tradeId}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs hover:border-[hsl(var(--gold)/0.3)]">
                <span>{row.tradeNumber} · Milestone {row.milestone} · {row.status.replace("_", " ")}</span>
                <span className="font-mono">${formatUsdc(row.amount)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No upcoming milestone cashflows.</p>
        )}
      </div>

      {/* Treasury */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Treasury Dashboard
          </h2>
          <Badge variant="outline" className="text-[10px] border-[hsl(var(--gold)/0.3)] text-gold">
            Merchant Finance
          </Badge>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <StatCard
            label="Settled Volume"
            value={`$${formatUsdc(settledVolume)}`}
            icon={Landmark}
            sub="completed + released trade flow"
          />
          <StatCard
            label="Released to Suppliers"
            value={`$${formatUsdc(releasedVolume)}`}
            icon={TrendingUp}
            sub="milestone payouts"
          />
          <StatCard
            label="Refunded to Buyers"
            value={`$${formatUsdc(refundedVolume)}`}
            icon={TrendingDown}
            sub="capital returned"
          />
          <StatCard
            label="Disputed Exposure"
            value={`$${formatUsdc(disputedExposure)}`}
            icon={Scale}
            sub="value currently disputed"
          />
          <StatCard
            label="Net Realized Flow"
            value={`$${formatUsdc(netRealizedFlow)}`}
            icon={ArrowLeftRight}
            sub="released minus refunded"
          />
          <StatCard
            label="Avg Milestone Release"
            value={`${avgDaysToRelease.toFixed(1)}d`}
            icon={Clock}
            sub="trade create -> milestone release"
          />
        </div>
      </div>

      {/* Pending actions banner */}
      {!loading && pendingAction.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-[hsl(var(--gold)/0.4)] bg-[hsl(var(--gold)/0.05)]">
          <AlertTriangle className="w-4 h-4 text-gold flex-shrink-0" />
          <p className="text-sm text-gold">
            {pendingAction.length} trade
            {pendingAction.length > 1 ? "s" : ""} need your attention -
            proof uploaded or funding required.
          </p>
        </div>
      )}

      {/* Recent trades */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Recent Trades
          </h2>
          <Link
            href="/trades"
            className="text-xs text-gold hover:underline flex items-center gap-1"
          >
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-md" />
            ))}
          </div>
        ) : filteredTrades.length === 0 ? (
          <div className="trade-card text-center py-12">
            <ArrowLeftRight className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No trades yet.{" "}
              <Link href="/trades/new" className="text-gold hover:underline">
                Start your first trade
              </Link>
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredTrades.slice(0, 6).map((trade) => (
              <TradeRow key={trade.id} trade={trade} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
