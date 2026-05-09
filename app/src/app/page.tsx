"use client";

import Image from "next/image";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ArrowRight, ShieldCheck, Link2, Blocks, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const PAIN_POINTS = [
  "Cross-border settlements rely on opaque chats and wire promises.",
  "Merchants absorb delay and delivery risk with little legal recourse.",
  "Banks and intermediaries add cost, friction, and settlement uncertainty.",
];

const SOLUTIONS = [
  {
    icon: ShieldCheck,
    title: "Milestone Escrow Logic",
    body: "USDC unlocks only when agreed milestones are completed and verified by both sides.",
  },
  {
    icon: Link2,
    title: "Shared Source of Truth",
    body: "Trade status, releases, and disputes are anchored on-chain for transparent counterpart accountability.",
  },
  {
    icon: Blocks,
    title: "Programmable Rules",
    body: "Every corridor trade follows structured steps for funding, proof, and release instead of manual negotiation.",
  },
];

export default function LandingPage() {
  const { login, authenticated, ready } = usePrivy();
  const router = useRouter();

  useEffect(() => {
    if (ready && authenticated) {
      router.push("/dashboard");
    }
  }, [ready, authenticated, router]);

  return (
    <div className="min-h-screen bg-black text-[#E6E6E6]">
      <section className="relative overflow-hidden">
        <div className="absolute inset-0">
          <Image
            src="/front-bg-image.png"
            alt="Tradeos corridor backdrop"
            fill
            priority
            className="hidden md:block object-cover object-center opacity-35"
          />
          <Image
            src="/front-hero-mobile.png"
            alt="Tradeos corridor mobile backdrop"
            fill
            priority
            className="md:hidden object-cover object-center opacity-40"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/75 to-black" />
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 md:px-10 py-5 sm:py-7 md:py-12">
          <nav className="flex items-center justify-between border border-[hsl(var(--gold)/0.24)] bg-black/65 backdrop-blur-xl rounded-xl px-3 sm:px-4 py-2.5 sm:py-3">
            <Image
              src="/logo-transparent-bg.png"
              alt="Tradeos"
              width={260}
              height={96}
              className="h-12 sm:h-14 md:h-16 w-auto"
            />
            <Button
              onClick={login}
              className="gradient-gold text-black font-semibold hover:opacity-90 text-xs sm:text-sm px-3 sm:px-4"
            >
              Trade <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </nav>

          <div className="pt-12 sm:pt-16 md:pt-24 pb-10 sm:pb-14 md:pb-24 text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-[hsl(var(--gold)/0.3)] bg-black/45 px-3 sm:px-4 py-1 sm:py-1.5 text-[10px] sm:text-xs tracking-[0.14em] sm:tracking-[0.18em] uppercase text-[#C9A45A]">
              <Globe2 className="w-3.5 h-3.5" />
              West Africa to UAE
            </p>

            <h1 className="mt-5 sm:mt-8 text-3xl sm:text-5xl md:text-7xl font-semibold leading-tight max-w-5xl mx-auto px-1">
              Programmable escrow for corridor traders
            </h1>

            <p className="mt-3 text-base sm:text-lg md:text-2xl text-[#E6D3A3] max-w-4xl mx-auto">
              Trade transparent, anonymous, and secure across borders.
            </p>

            <p className="mt-3 sm:mt-5 text-xs sm:text-sm md:text-lg text-[#d0d0d0] max-w-3xl mx-auto leading-relaxed px-2">
              Tradeos secures cross-border shipments with milestone-based USDC settlement,
              dispute workflows, and transparent execution from funding to release on Solana.
            </p>

            <div className="mt-6 sm:mt-8 flex flex-col sm:flex-row justify-center gap-2.5 sm:gap-3 px-2">
              <Button
                onClick={login}
                size="lg"
                className="gradient-gold text-black font-semibold hover:opacity-90 text-sm sm:text-base"
              >
                Start Secured Trade
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="border-[hsl(var(--gold)/0.35)] text-[#E6D3A3] hover:bg-[hsl(var(--gold)/0.1)] text-sm sm:text-base"
              >
                <a
                  href={`https://solscan.io/account/${process.env.NEXT_PUBLIC_PROGRAM_ID}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View Smart Contract
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-6 md:px-10 py-8 sm:py-10 md:py-16 grid lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="trade-card bg-black/70 border-[hsl(var(--gold)/0.2)]">
          <h2 className="text-lg sm:text-xl md:text-2xl font-semibold text-[#E6D3A3]">
            The problem today
          </h2>
          <ul className="mt-3 sm:mt-4 space-y-2.5 sm:space-y-3 text-xs sm:text-sm text-[#d9d9d9]">
            {PAIN_POINTS.map((point) => (
              <li
                key={point}
                className="rounded-md border border-[hsl(var(--gold)/0.18)] bg-black/45 px-3 py-2.5"
              >
                {point}
              </li>
            ))}
          </ul>
        </div>

        <div className="trade-card bg-black/70 border-[hsl(var(--gold)/0.2)]">
          <h2 className="text-lg sm:text-xl md:text-2xl font-semibold text-[#E6D3A3]">
            How Tradeos solves it
          </h2>
          <div className="mt-3 sm:mt-4 space-y-2.5 sm:space-y-3">
            {SOLUTIONS.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="rounded-md border border-[hsl(var(--gold)/0.18)] bg-black/45 p-3.5"
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-[#D4AF6A]" />
                  <h3 className="font-semibold text-xs sm:text-sm">{title}</h3>
                </div>
                <p className="text-xs sm:text-sm text-[#d0d0d0] mt-2 leading-relaxed">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
