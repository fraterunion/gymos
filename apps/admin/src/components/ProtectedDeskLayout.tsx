"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { DeskShell } from "@/components/DeskShell";
import { useAuth } from "@/contexts/AuthContext";

export function ProtectedDeskLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, hydrated } = useAuth();

  useEffect(() => {
    if (!hydrated) return;
    if (!user) router.replace("/login");
  }, [hydrated, user, router]);

  if (!hydrated || !user) {
    return (
      <div className="flex min-h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  return <DeskShell>{children}</DeskShell>;
}
