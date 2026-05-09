import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="trade-card max-w-md text-center space-y-3">
        <p className="text-xs uppercase tracking-widest text-red-300">403</p>
        <h1 className="text-xl font-semibold">Access forbidden</h1>
        <p className="text-sm text-muted-foreground">
          You do not have permission to view this page.
        </p>
        <Link href="/dashboard" className="text-sm text-gold hover:underline">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
