"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import {
  Wallet,
  Copy,
  Check,
  ExternalLink,
  ArrowDownLeft,
  ArrowUpRight,
  RefreshCw,
  Droplets,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cn,
  formatUsdc,
  shortAddress,
  formatDate,
  solscanAccountUrl,
  solscanTxUrl,
} from "@/lib/utils";
import { USDC_MINT } from "@/lib/constants";

type MilestoneEvent = {
  trade_number: string;
  trade_id: string;
  milestone_number: number;
  direction: "in" | "out";
  amount_usdc: number;
  tx_signature: string | null;
  released_at: string;
  description: string;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-muted-foreground hover:text-[#D4AF6A] transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function TxRow({ event }: { event: MilestoneEvent }) {
  const isIn = event.direction === "in";
  return (
    <div className="flex items-center justify-between px-4 py-3 rounded-md border border-[hsl(var(--gold)/0.2)] bg-black/35 hover:bg-black/55 transition-colors">
      <div className="flex items-center gap-3">
        <div className={cn("w-8 h-8 rounded-full flex items-center justify-center", isIn ? "bg-green-500/10 text-green-400" : "bg-red-400/10 text-red-400")}>
          {isIn ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
        </div>
        <div>
          <p className="text-sm font-medium">{isIn ? "Release Received" : "Escrow Funded"} - {event.description}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] font-mono text-muted-foreground">{event.trade_number}</span>
            {event.tx_signature ? (
              <a href={solscanTxUrl(event.tx_signature)} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[#D4AF6A] hover:underline">
                View Tx
              </a>
            ) : null}
          </div>
        </div>
      </div>
      <div className="text-right">
        <p className={cn("text-sm font-mono font-bold", isIn ? "text-green-400" : "text-[#E6E6E6]")}>
          {isIn ? "+" : "-"}${formatUsdc(event.amount_usdc)}
        </p>
        <p className="text-[10px] text-muted-foreground">{formatDate(event.released_at)}</p>
      </div>
    </div>
  );
}

export default function WalletPage() {
  const { getAccessToken } = usePrivy();
  const { wallets } = useWallets();

  const walletAddress = useMemo(() => {
    const allWallets = wallets as Array<{ address?: string; walletClientType?: string }>;
    const embedded = allWallets.find((w) => w.walletClientType === "privy" && !!w.address);
    const fallback = allWallets.find((w) => !!w.address);
    return embedded?.address ?? fallback?.address ?? null;
  }, [wallets]);

  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState<MilestoneEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);

  const fetchBalance = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch("/api/wallet/balance", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setBalance(data.balance);
      }
    } finally {
      setBalanceLoading(false);
      setRefreshing(false);
    }
  }, [getAccessToken]);

  const fetchEvents = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch("/api/wallet/transactions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setEvents(await res.json());
    } finally {
      setEventsLoading(false);
    }
  }, [getAccessToken]);

  useEffect(() => {
    fetchBalance();
    fetchEvents();
  }, [fetchBalance, fetchEvents]);

  return (
    <div className="space-y-8 animate-fade-in">
      <section className="relative overflow-hidden rounded-2xl border border-[hsl(var(--gold)/0.26)] bg-black p-6 md:p-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(212,175,106,0.22),transparent_40%)]" />
        <div className="relative z-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg gradient-gold flex items-center justify-center">
                <Wallet className="w-5 h-5 text-black" />
              </div>
              <div>
                <h1 className="text-2xl md:text-3xl font-semibold text-[#E6E6E6]">Treasury Wallet</h1>
                <p className="text-sm text-[#C9A45A]">Exclusive settlement vault for your Tradeos account</p>
              </div>
            </div>
            <button onClick={() => fetchBalance(true)} disabled={refreshing} className="rounded-md border border-[hsl(var(--gold)/0.3)] p-2 text-[#D4AF6A] hover:bg-[hsl(var(--gold)/0.12)]">
              <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            </button>
          </div>

          <div className="mt-8 grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-[hsl(var(--gold)/0.22)] bg-black/45 p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">USDC Balance</p>
              {balanceLoading ? (
                <Skeleton className="h-10 w-40 mt-3 shimmer-gold" />
              ) : (
                <p className="mt-3 text-4xl font-mono font-bold text-[#E6D3A3]">${balance !== null ? formatUsdc(balance) : "-"}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">Solana devnet account balance</p>
            </div>
            <div className="rounded-xl border border-[hsl(var(--gold)/0.22)] bg-black/45 p-4 space-y-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Wallet Identity</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm text-[#E6E6E6]">{walletAddress ? shortAddress(walletAddress, 8) : "Not connected"}</p>
                {walletAddress ? <CopyButton text={walletAddress} /> : null}
                {walletAddress ? (
                  <a href={solscanAccountUrl(walletAddress)} target="_blank" rel="noopener noreferrer" className="text-[#D4AF6A] hover:text-[#E6D3A3]">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : null}
              </div>
              <p className="font-mono text-xs text-muted-foreground">USDC Mint: {shortAddress(USDC_MINT, 8)}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Droplets className="w-3.5 h-3.5 text-[#D4AF6A]" />
                <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" className="text-[#D4AF6A] hover:underline">
                  Request devnet USDC from Circle faucet
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-[0.18em] text-[#C9A45A] mb-3">Settlement Timeline</h2>
        {eventsLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-md shimmer-gold" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-xl border border-[hsl(var(--gold)/0.22)] bg-black/35 py-10 text-center">
            <p className="text-sm text-muted-foreground">No settlement events yet. Your escrow activity appears here.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((event, i) => (
              <TxRow key={`${event.trade_id}-${event.milestone_number}-${i}`} event={event} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
