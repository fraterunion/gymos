"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/contexts/AuthContext";

export default function HomePage() {
  const router = useRouter();
  const { user, hydrated } = useAuth();

  useEffect(() => {
    if (!hydrated) return;
    router.replace(user ? "/check-in" : "/login");
  }, [hydrated, user, router]);

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <p className="text-sm text-zinc-500">Loading…</p>
    </div>
  );
}
