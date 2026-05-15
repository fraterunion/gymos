"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { PlatformShell } from "@/components/PlatformShell";
import { DeskStudioProvider } from "@/contexts/DeskStudioContext";
import { useAuth } from "@/contexts/AuthContext";
import { isPlatformOperatorEmail } from "@/lib/platformAccess";

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, hydrated } = useAuth();

  useEffect(() => {
    if (!hydrated) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!isPlatformOperatorEmail(user.email)) {
      router.replace("/check-in");
    }
  }, [hydrated, user, router]);

  if (!hydrated || !user) {
    return (
      <div className="flex min-h-full flex-1 items-center justify-center bg-zinc-950">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (!isPlatformOperatorEmail(user.email)) {
    return (
      <div className="flex min-h-full flex-1 items-center justify-center bg-zinc-950">
        <p className="text-sm text-zinc-500">Redirecting…</p>
      </div>
    );
  }

  return (
    <DeskStudioProvider>
      <PlatformShell>{children}</PlatformShell>
    </DeskStudioProvider>
  );
}
