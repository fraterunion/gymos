import {
  canAccessWalkInSales,
  canManageStudioSettings,
  isFrontDeskRole,
  normalizeStudioRole,
} from "@/lib/deskRoles";

export type AdminNavItem = {
  href: string;
  label: string;
  matchPrefix?: boolean;
};

export type AdminNavContext = {
  role: string | null;
  ready: boolean;
  loading: boolean;
};

export type AdminNavStructure = {
  primary: AdminNavItem[];
  more: AdminNavItem[];
};

function isActive(pathname: string, href: string, matchPrefix = true): boolean {
  if (pathname === href) return true;
  if (!matchPrefix) return false;
  return pathname.startsWith(`${href}/`);
}

export function getAdminNavStructure(ctx: AdminNavContext): AdminNavStructure {
  const { role, ready, loading } = ctx;
  const rolePending = !ready || loading;
  const resolved = normalizeStudioRole(role);
  const frontDesk = ready && isFrontDeskRole(resolved);
  const canManage = ready && canManageStudioSettings(resolved);
  const canSales = ready && canAccessWalkInSales(resolved);

  if (rolePending) {
    return { primary: [{ href: "/check-in", label: "Inicio" }], more: [] };
  }

  if (frontDesk) {
    const primary: AdminNavItem[] = [{ href: "/check-in", label: "Inicio" }];
    if (canSales) primary.push({ href: "/sales", label: "Ventas" });
    primary.push({ href: "/scan", label: "Escáner" });
    return { primary, more: [] };
  }

  const primary: AdminNavItem[] = [
    { href: "/check-in", label: "Inicio" },
    ...(canSales ? [{ href: "/sales", label: "Ventas" }] : []),
    { href: "/schedule", label: "Calendario" },
    { href: "/members", label: "Miembros" },
    ...(canManage ? [{ href: "/memberships", label: "Membresías" }] : []),
    ...(canManage ? [{ href: "/staff", label: "Equipo" }] : []),
    { href: "/analytics", label: "Analytics" },
  ];

  const more: AdminNavItem[] = [
    { href: "/classes", label: "Clases" },
    ...(canManage ? [{ href: "/schedule-generator", label: "Generador" }] : []),
    ...(canManage ? [{ href: "/builds", label: "Builds" }] : []),
    ...(canManage ? [{ href: "/settings", label: "Configuración" }] : []),
  ];

  return { primary, more };
}

/** @deprecated Use getAdminNavStructure */
export function getAdminNavItems(ctx: AdminNavContext): AdminNavItem[] {
  const { primary, more } = getAdminNavStructure(ctx);
  return [...primary, ...more];
}

export function isAdminNavActive(pathname: string, item: AdminNavItem): boolean {
  return isActive(pathname, item.href, item.matchPrefix !== false);
}

export function isMoreMenuActive(pathname: string, items: AdminNavItem[]): boolean {
  return items.some((item) => isAdminNavActive(pathname, item));
}
