"use client";

import { AdminHeader } from "@/components/shell/AdminHeader";
import { AdminPageShell } from "@/components/shell/AdminPageShell";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { isFrontDeskAllowedPath, isFrontDeskRole, normalizeStudioRole } from "@/lib/deskRoles";
import { usePathname } from "next/navigation";

export function DeskShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { studioRole, loading, ready } = useDeskStudio();

  const resolvedRole = normalizeStudioRole(studioRole);
  const frontDesk = ready && isFrontDeskRole(resolvedRole);
  const rolePending = !ready || loading;

  return (
    <div className="flex min-h-full flex-col bg-[#fafafa] text-zinc-900">
      <AdminHeader />
      <AdminPageShell>
        {frontDesk && !rolePending && !isFrontDeskAllowedPath(pathname) ? (
          <p className="text-sm text-zinc-500">Redirigiendo…</p>
        ) : (
          children
        )}
      </AdminPageShell>
    </div>
  );
}
