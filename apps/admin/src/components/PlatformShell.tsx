"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useAuth } from "@/contexts/AuthContext";
import { useDeskStudio } from "@/contexts/DeskStudioContext";

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { studios, selectedStudioId, setStudioId, selected, loading } = useDeskStudio();

  return (
    <div className="flex min-h-full flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-amber-950/40 bg-zinc-950/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-4 px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-500/90">
              FraterUnion Platform Console
            </p>
            <h1 className="mt-1 text-sm font-semibold text-zinc-100">Internal tools — not visible to gym clients</h1>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500">
              Tenant mobile identifiers and store readiness. Desk operators use{" "}
              <Link href="/settings" className="text-violet-400 underline-offset-2 hover:underline">
                Studio settings
              </Link>{" "}
              for day-to-day branding and booking rules.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/check-in"
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                pathname === "/check-in" || pathname.startsWith("/check-in/")
                  ? "bg-zinc-100 text-zinc-900"
                  : "border border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              Client desk
            </Link>
            <Link
              href="/platform"
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                pathname === "/platform" || pathname.startsWith("/platform/")
                  ? "bg-amber-500/20 text-amber-100 ring-1 ring-amber-500/40"
                  : "border border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              Platform
            </Link>
            {user ? (
              <span className="hidden text-[11px] text-zinc-500 sm:inline">{user.email}</span>
            ) : null}
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
            >
              Sign out
            </button>
          </div>
        </div>
        <div className="border-t border-zinc-800/80 bg-zinc-950/80 px-4 py-2 sm:px-6">
          {loading ? (
            <span className="text-xs text-zinc-500">Loading studios…</span>
          ) : studios.length > 0 ? (
            <label className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span className="font-medium text-zinc-500">Tenant</span>
              <select
                className="max-w-[280px] rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
                value={selectedStudioId ?? ""}
                onChange={(e) => setStudioId(e.target.value)}
              >
                {studios.map((row) => (
                  <option key={row.studio.id} value={row.studio.id}>
                    {row.studio.name} · {row.role}
                  </option>
                ))}
              </select>
              {selected ? (
                <span className="text-zinc-600">
                  {selected.studio.slug} · {selected.studio.timezone}
                </span>
              ) : null}
            </label>
          ) : (
            <span className="text-xs text-amber-200/80">No studios on this account.</span>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
