"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AdminNavigation } from "@/components/shell/AdminNavigation";
import { useAuth } from "@/contexts/AuthContext";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import {
  isFrontDeskAllowedPath,
  isFrontDeskRole,
  normalizeStudioRole,
} from "@/lib/deskRoles";
import { isPlatformAdmin } from "@/lib/platformAccess";

export function AdminHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { studios, selectedStudioId, setStudioId, selected, studioRole, loading, ready } =
    useDeskStudio();

  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  const resolvedRole = normalizeStudioRole(studioRole);
  const frontDesk = ready && isFrontDeskRole(resolvedRole);
  const rolePending = !ready || loading;

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!accountOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [accountOpen]);

  useEffect(() => {
    if (rolePending || !frontDesk) return;
    if (!isFrontDeskAllowedPath(pathname)) {
      router.replace("/check-in");
    }
  }, [rolePending, frontDesk, pathname, router]);

  const displayName = user?.email?.split("@")[0] ?? "Cuenta";
  const studioLabel = selected?.studio.name ?? "Estudio";

  return (
    <>
      <header className="sticky top-0 z-50 bg-[#0a0a0a] text-white">
        <div className="mx-auto flex h-[68px] max-w-[1600px] items-center gap-4 px-4 sm:px-6 lg:px-8">
          <Link
            href="/check-in"
            className="flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            aria-label="ARES — Inicio"
          >
            <Image
              src="/ares-logo.png"
              alt="ARES Training Club"
              width={108}
              height={28}
              className="h-7 w-auto max-w-[108px] object-contain object-left"
              priority
            />
          </Link>

          <AdminNavigation role={studioRole} ready={ready} loading={loading} />

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {!rolePending && studios.length > 0 ? (
              <label className="hidden items-center sm:flex">
                <span className="sr-only">Estudio</span>
                <select
                  className="max-w-[200px] rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-60"
                  value={selectedStudioId ?? ""}
                  onChange={(e) => setStudioId(e.target.value)}
                  disabled={frontDesk}
                >
                  {studios.map((row) => (
                    <option key={row.studio.id} value={row.studio.id}>
                      {row.studio.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : rolePending ? (
              <span className="hidden text-xs text-zinc-500 sm:inline">Cargando…</span>
            ) : null}

            {user && isPlatformAdmin(user.platformRole) && ready && !frontDesk ? (
              <Link
                href="/platform"
                className="hidden rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:inline"
              >
                Platform
              </Link>
            ) : null}

            <div className="relative" ref={accountRef}>
              <button
                type="button"
                onClick={() => setAccountOpen((o) => !o)}
                className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                aria-expanded={accountOpen}
                aria-haspopup="menu"
              >
                <span className="hidden max-w-[120px] truncate md:inline">{displayName}</span>
                <span
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-700 text-[11px] font-semibold uppercase text-white"
                  aria-hidden
                >
                  {displayName.slice(0, 2)}
                </span>
              </button>
              {accountOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-zinc-200 bg-white py-1 text-zinc-900 shadow-lg"
                >
                  <div className="border-b border-zinc-100 px-4 py-3">
                    <p className="truncate text-sm font-medium text-zinc-900">{user?.email}</p>
                    <p className="truncate text-xs text-zinc-500">{studioLabel}</p>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full px-4 py-2.5 text-left text-sm text-zinc-700 hover:bg-zinc-50"
                    onClick={() => {
                      setAccountOpen(false);
                      void logout();
                    }}
                  >
                    Cerrar sesión
                  </button>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white lg:hidden"
              aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                {menuOpen ? (
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                ) : (
                  <path
                    d="M4 7h16M4 12h16M4 17h16"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
          </div>
        </div>
      </header>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Cerrar menú"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute left-0 top-[68px] h-[calc(100%-68px)] w-[min(100%,280px)] overflow-y-auto bg-[#0a0a0a] shadow-xl">
            {!rolePending && studios.length > 0 ? (
              <div className="border-b border-zinc-800 p-4">
                <label className="block text-xs text-zinc-500">Estudio</label>
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-200"
                  value={selectedStudioId ?? ""}
                  onChange={(e) => setStudioId(e.target.value)}
                  disabled={frontDesk}
                >
                  {studios.map((row) => (
                    <option key={row.studio.id} value={row.studio.id}>
                      {row.studio.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <AdminNavigation
              role={studioRole}
              ready={ready}
              loading={loading}
              variant="drawer"
              onNavigate={() => setMenuOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
