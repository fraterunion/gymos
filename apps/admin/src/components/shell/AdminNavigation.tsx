"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  getAdminNavStructure,
  isAdminNavActive,
  isMoreMenuActive,
  type AdminNavContext,
  type AdminNavItem,
} from "@/lib/adminNav";

type AdminNavigationProps = AdminNavContext & {
  variant?: "header" | "drawer";
  onNavigate?: () => void;
};

function NavLink({
  item,
  active,
  onNavigate,
  compact,
}: {
  item: AdminNavItem;
  active: boolean;
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const base = compact
    ? "block rounded-xl px-4 py-2.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    : "rounded-full px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white whitespace-nowrap xl:px-3 xl:text-sm";

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={
        active
          ? `${base} bg-white text-zinc-900`
          : `${base} text-zinc-400 hover:text-zinc-200`
      }
      aria-current={active ? "page" : undefined}
    >
      {item.label}
    </Link>
  );
}

function MoreMenu({
  items,
  pathname,
  onNavigate,
  variant,
}: {
  items: AdminNavItem[];
  pathname: string;
  onNavigate?: () => void;
  variant: "header" | "drawer";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = isMoreMenuActive(pathname, items);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (items.length === 0) return null;

  if (variant === "drawer") {
    return (
      <div className="border-t border-zinc-800 px-4 py-3">
        <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Más
        </p>
        <div className="flex flex-col gap-1">
          {items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isAdminNavActive(pathname, item)}
              onNavigate={onNavigate}
              compact
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white whitespace-nowrap xl:px-3 xl:text-sm ${
          active ? "bg-white text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
        }`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        Más
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-2 min-w-[180px] rounded-xl border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {items.map((item) => {
            const itemActive = isAdminNavActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
                className={`block px-4 py-2.5 text-sm ${
                  itemActive
                    ? "bg-zinc-100 font-medium text-zinc-900"
                    : "text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function AdminNavigation({
  role,
  ready,
  loading,
  variant = "header",
  onNavigate,
}: AdminNavigationProps) {
  const pathname = usePathname();
  const { primary, more } = getAdminNavStructure({ role, ready, loading });

  if (variant === "drawer") {
    return (
      <nav className="flex flex-col" aria-label="Navegación principal">
        <div className="flex flex-col gap-1 p-4">
          {primary.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isAdminNavActive(pathname, item)}
              onNavigate={onNavigate}
              compact
            />
          ))}
        </div>
        <MoreMenu items={more} pathname={pathname} onNavigate={onNavigate} variant="drawer" />
      </nav>
    );
  }

  return (
    <nav className="hidden min-w-0 flex-1 items-center gap-0.5 lg:flex" aria-label="Navegación principal">
      {primary.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={isAdminNavActive(pathname, item)}
          compact={false}
        />
      ))}
      <MoreMenu items={more} pathname={pathname} variant="header" />
    </nav>
  );
}
