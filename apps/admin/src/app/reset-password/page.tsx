"use client";

import { Suspense, useEffect } from "react";

import { MEMBER_RECOVERY_ORIGIN } from "@/lib/memberRecovery";

/**
 * Legacy compatibility only. Password recovery moved to the member-facing studio domain;
 * reset links already delivered (and bookmarks) still point here, so this forwards them.
 *
 * The forward is done CLIENT-side on purpose: a server redirect would place the one-time
 * token in a Location response header and in edge access logs for a second hop. Here the
 * token never leaves the browser — it is read from the URL and handed straight to the
 * destination, and nothing is written to storage.
 */
function LegacyResetRedirect() {
  useEffect(() => {
    const target = new URL("/reset-password", MEMBER_RECOVERY_ORIGIN);
    // Carry the query through verbatim (token + studio) without inspecting or logging it.
    target.search = window.location.search;
    window.location.replace(target.toString());
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <p className="text-sm text-zinc-500">Redirigiendo…</p>
    </main>
  );
}

export default function LegacyResetPasswordPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-zinc-50" />}>
      <LegacyResetRedirect />
    </Suspense>
  );
}
