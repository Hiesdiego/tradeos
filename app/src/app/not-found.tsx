import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="trade-card max-w-md text-center space-y-3">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">404</p>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          The page may have moved or no longer exists.
        </p>
        <Link href="/dashboard" className="text-sm text-gold hover:underline">
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
