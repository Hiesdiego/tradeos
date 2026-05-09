"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard,
  ArrowLeftRight,
  ArrowUpDown,
  Wallet,
  Star,
  ShieldAlert,
  LogOut,
  PlusCircle,
  X,
} from "lucide-react";
import { cn, shortAddress } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isAdminWallet } from "@/lib/constants";

type ReputationSummary = {
  buyer_reputation?: { score: string; max: number; trades: number };
  merchant_reputation?: { score: string; max: number; trades: number };
};

const BASE_NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
  { href: "/ramps", label: "Ramps", icon: ArrowUpDown },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/reputation", label: "Reputation", icon: Star },
];

export function Sidebar({
  mobileOpen = false,
  onClose,
}: {
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const { user, logout, authenticated, getAccessToken } = usePrivy();
  const [summary, setSummary] = useState<ReputationSummary | null>(null);

  const walletAddress =
    user?.wallet?.address ??
    user?.linkedAccounts?.find((a) => a.type === "wallet")?.address ??
    null;

  const adminVisible = isAdminWallet(walletAddress);

  const navItems = useMemo(
    () =>
      adminVisible
        ? [...BASE_NAV_ITEMS, { href: "/admin", label: "Admin", icon: ShieldAlert }]
        : BASE_NAV_ITEMS,
    [adminVisible]
  );

  useEffect(() => {
    let active = true;
    async function loadReputation() {
      try {
        if (!authenticated) return;
        const token = await getAccessToken();
        if (!token) return;
        const meRes = await fetch("/api/users/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!meRes.ok) return;
        const me = await meRes.json();
        const repRes = await fetch(`/api/users/${me.id}/reputation`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!repRes.ok || !active) return;
        setSummary(await repRes.json());
      } catch {}
    }
    loadReputation();
    return () => {
      active = false;
    };
  }, [authenticated, getAccessToken]);

  const SidebarBody = (
    <aside className="h-full w-72 bg-black/95 border-r border-[hsl(var(--gold)/0.2)] flex flex-col backdrop-blur-xl">
      <div className="px-5 py-5 border-b border-[hsl(var(--gold)/0.15)]">
        <div className="flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-3" onClick={onClose}>
            <Image src="/logo-transparent-bg.png" alt="Tradeos" width={190} height={68} className="h-12 w-auto" />
          </Link>
          {onClose ? (
            <button onClick={onClose} className="md:hidden text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          ) : null}
        </div>
        <p className="text-[10px] text-[#C9A45A] mt-2 font-mono tracking-[0.18em] uppercase">
          Corridor Trust Rail
        </p>
      </div>

      <div className="px-3 pt-4">
        <Button asChild size="sm" className="w-full gradient-gold text-black font-semibold text-xs h-9 hover:opacity-90">
          <Link href="/trades/new" onClick={onClose}>
            <PlusCircle className="w-3.5 h-3.5 mr-1.5" />
            Create Trade
          </Link>
        </Button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-all duration-150 border",
                active
                  ? "bg-[hsl(var(--gold)/0.14)] text-[#E6D3A3] border-[hsl(var(--gold)/0.35)]"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              )}
            >
              <Icon className={cn("w-4 h-4", active && "text-[#D4AF6A]")} strokeWidth={active ? 2 : 1.5} />
              {label}
            </Link>
          );
        })}
      </nav>

      {authenticated && (
        <div className="px-3 pb-4 border-t border-[hsl(var(--gold)/0.15)] pt-3 space-y-2">
          <div className="rounded-md bg-secondary/40 border border-border p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Wallet</p>
            <p className="text-xs font-mono text-[#E6E6E6]">{walletAddress ? shortAddress(walletAddress) : "Not connected"}</p>
            <div className="mt-2 text-[10px] text-muted-foreground grid grid-cols-2 gap-1">
              <p>Buyer Rep</p>
              <p className="text-right text-[#D4AF6A]">
                {summary?.buyer_reputation?.score ?? "0.0"}/5
              </p>
              <p>Merchant Rep</p>
              <p className="text-right text-[#D4AF6A]">
                {summary?.merchant_reputation?.score ?? "0.0"}/5
              </p>
            </div>
          </div>

          <button onClick={logout} className="w-full flex items-center justify-center gap-2 text-xs py-2 rounded-md border border-border text-muted-foreground hover:text-red-300 hover:border-red-400/40 transition-colors">
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      )}
    </aside>
  );

  if (onClose) {
    return (
      <>
        <div
          className={cn(
            "fixed inset-0 z-40 bg-black/70 transition-opacity md:hidden",
            mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          )}
          onClick={onClose}
        />
        <div
          className={cn(
            "fixed left-0 top-0 z-50 h-screen transition-transform duration-300 md:hidden",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          {SidebarBody}
        </div>
      </>
    );
  }

  return <div className="hidden md:block fixed left-0 top-0 h-screen z-40">{SidebarBody}</div>;
}
