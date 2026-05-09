"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Menu } from "lucide-react";
import Image from "next/image";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { authenticated, ready } = usePrivy();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (ready && !authenticated) {
      router.push("/");
    }
  }, [ready, authenticated, router]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-4">
          <div className="relative h-14 w-14 rounded-xl overflow-hidden border border-[hsl(var(--gold)/0.35)]">
            <div className="absolute inset-0 shimmer-gold" />
          </div>
          <p className="text-xs text-[#C9A45A] font-mono tracking-[0.2em] uppercase">
            Securing Session
          </p>
        </div>
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    <div className="flex h-screen bg-black">
      <Sidebar />
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

      <main className="flex-1 md:ml-72 overflow-y-auto">
        <div className="md:hidden sticky top-0 z-30 border-b border-[hsl(var(--gold)/0.2)] bg-black/90 backdrop-blur-xl px-4 py-3 flex items-center justify-between">
          <button onClick={() => setMobileOpen(true)} className="text-[#E6E6E6]">
            <Menu className="w-5 h-5" />
          </button>
          <Image
            src="/logo-transparent-bg.png"
            alt="Tradeos"
            width={170}
            height={62}
            className="h-10 w-auto"
          />
          <div className="w-5 h-5" />
        </div>
        <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-8 py-4 sm:py-6 md:py-8">{children}</div>
      </main>
    </div>
  );
}
