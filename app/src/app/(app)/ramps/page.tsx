"use client";

import { ArrowDownToLine, ArrowUpFromLine, AlertCircle, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function RampsPage() {
  return (
    <div className="space-y-8 animate-fade-in">
      <section className="relative overflow-hidden rounded-2xl border border-[hsl(var(--gold)/0.26)] bg-black p-6 md:p-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,rgba(212,175,106,0.2),transparent_40%)]" />
        <div className="relative z-10">
          <h1 className="text-2xl md:text-3xl font-semibold text-[#E6E6E6]">On-ramp & Off-ramp</h1>
          <p className="text-sm text-[#C9A45A] mt-2">
            Fiat-to-crypto and crypto-to-fiat rails for Tradeos treasury.
          </p>
        </div>
      </section>

      <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 flex items-start gap-3">
        <AlertCircle className="w-4 h-4 text-yellow-300 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-yellow-200">Not available in Devnet</p>
          <p className="text-xs text-yellow-100/90 mt-1">
            On-ramp and off-ramp are disabled in test environments. This feature is coming in production.
          </p>
        </div>
      </div>

      <section className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[hsl(var(--gold)/0.22)] bg-black/45 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ArrowDownToLine className="w-4 h-4 text-[#D4AF6A]" />
            <h2 className="text-sm font-semibold text-[#E6E6E6]">On-ramp</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Buy USDC with local payment rails and settle directly into your Tradeos wallet.
          </p>
          <Button disabled className="w-full opacity-60 cursor-not-allowed">
            Coming to Production
          </Button>
        </div>

        <div className="rounded-xl border border-[hsl(var(--gold)/0.22)] bg-black/45 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ArrowUpFromLine className="w-4 h-4 text-[#D4AF6A]" />
            <h2 className="text-sm font-semibold text-[#E6E6E6]">Off-ramp</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Convert released USDC to local fiat and withdraw through supported payout partners.
          </p>
          <Button disabled className="w-full opacity-60 cursor-not-allowed">
            Coming to Production
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-[hsl(var(--gold)/0.22)] bg-black/35 p-4 flex items-start gap-3">
        <Rocket className="w-4 h-4 text-[#D4AF6A] mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-[#E6E6E6]">Production rollout plan</p>
          <p className="text-xs text-muted-foreground mt-1">
            This page is in place so integration can be enabled safely per region and provider once production keys and compliance rails are active.
          </p>
        </div>
      </section>
    </div>
  );
}
