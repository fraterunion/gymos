"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useAuth } from "@/contexts/AuthContext";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { isPlatformOperatorEmail } from "@/lib/platformAccess";

export function DeskShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { studios, selectedStudioId, setStudioId, selected, loading } = useDeskStudio();

  const canManageStudioSettings =
    selected?.role === "OWNER" || selected?.role === "ADMIN";

  const navItems = [
    { href: "/check-in", label: "Today" },
    { href: "/schedule", label: "Schedule" },
    { href: "/classes", label: "Class types" },
    { href: "/members", label: "Members" },
    ...(canManageStudioSettings
      ? ([{ href: "/staff", label: "Staff" }] as const)
      : []),
    { href: "/analytics", label: "Analytics" },
    ...(canManageStudioSettings
      ? ([
          { href: "/builds", label: "Builds" },
          { href: "/settings", label: "Settings" },
        ] as const)
      : []),
  ];

  return (
    <div className="flex min-h-full flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <header className="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/90 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <Link href="/check-in" className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Check-in desk
          </Link>
          <nav className="flex flex-1 flex-wrap items-center gap-1 text-sm">
            {navItems.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`rounded-lg px-2 py-1 font-medium ${
                  pathname === href || pathname.startsWith(`${href}/`)
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            {loading ? (
              <span className="text-xs text-zinc-500">Loading studios…</span>
            ) : studios.length > 0 ? (
              <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="hidden sm:inline">Studio</span>
                <select
                  className="max-w-[220px] rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  value={selectedStudioId ?? ""}
                  onChange={(e) => setStudioId(e.target.value)}
                >
                  {studios.map((row) => (
                    <option key={row.studio.id} value={row.studio.id}>
                      {row.studio.name} · {row.role}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {user && isPlatformOperatorEmail(user.email) ? (
              <Link
                href="/platform"
                className={`hidden rounded-lg border px-2 py-1 text-[11px] font-semibold sm:inline ${
                  pathname === "/platform" || pathname.startsWith("/platform/")
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-200"
                    : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500"
                }`}
              >
                Platform
              </Link>
            ) : null}
            {user ? (
              <span className="hidden text-xs text-zinc-500 md:inline dark:text-zinc-400">{user.email}</span>
            ) : null}
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </div>
        </div>
        {selected ? (
          <div className="border-t border-zinc-100 px-4 py-1.5 text-center text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
            Timezone · {selected.studio.timezone}
          </div>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
