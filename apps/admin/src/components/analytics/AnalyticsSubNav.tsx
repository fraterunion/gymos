"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/analytics", label: "Resumen", exact: true },
  { href: "/analytics/members", label: "Miembros", exact: false },
  { href: "/analytics/retention", label: "Retención", exact: false },
  { href: "/analytics/classes", label: "Clases y horarios", exact: false },
];

export function AnalyticsSubNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex gap-1 border-b border-zinc-200">
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              "px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-b-2 border-zinc-900 text-zinc-900"
                : "text-zinc-500 hover:text-zinc-800",
            ].join(" ")}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
