"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { getPublicApiOrigin } from "@/lib/env";

export default function LoginPage() {
  const router = useRouter();
  const { user, hydrated, login, error, logout } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (user) router.replace("/check-in");
  }, [hydrated, user, router]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLocalError(null);
      if (!getPublicApiOrigin()) {
        setLocalError("This desk app is not connected to your studio server yet. Ask your technical contact to finish setup.");
        return;
      }
      setBusy(true);
      try {
        await login(email, password);
        router.replace("/check-in");
      } catch {
        // error from context
      } finally {
        setBusy(false);
      }
    },
    [email, password, login, router],
  );

  if (!hydrated) {
    return (
      <div className="flex min-h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  const err = localError || error;

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4 py-16 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Sign in</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Staff check-in desk — use your studio credentials.</p>
        <form onSubmit={(e) => void onSubmit(e)} className="mt-8 space-y-4">
          <div>
            <label htmlFor="email" className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
          </div>
          {err ? <p className="text-sm text-red-600 dark:text-red-400">{err}</p> : null}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-zinc-900 py-3 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {busy ? "Signing in…" : "Continue"}
          </button>
        </form>
        {user ? (
          <p className="mt-6 text-center text-sm text-zinc-500">
            Signed in as {user.email}.{" "}
            <button type="button" className="font-medium text-zinc-900 underline dark:text-zinc-200" onClick={() => void logout()}>
              Sign out
            </button>
          </p>
        ) : null}
        <p className="mt-8 text-center text-xs text-zinc-400">
          <Link href="/check-in" className="underline">
            Open check-in
          </Link>
        </p>
      </div>
    </div>
  );
}
