"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";

import {
  PublicAuthButton,
  PublicAuthNotice,
  PublicAuthShell,
  publicAuthInput,
  publicAuthLabel,
  usePublicAuthBrand,
} from "@/components/public-auth/PublicAuthShell";
import { forgotPasswordRequest } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/errors";
import { DEFAULT_PUBLIC_AUTH_LOCALE, FORGOT_COPY } from "@/lib/publicAuthCopy";

/**
 * Public "forgot password" page. Members reach it too (from the app, or from a reset page
 * whose link has expired), so it requires no session and carries no admin chrome.
 *
 * The API answers identically whether or not the address has an account, and so does this
 * page: one confirmation state, never a branch on existence.
 */

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const copy = FORGOT_COPY[DEFAULT_PUBLIC_AUTH_LOCALE];
  const studioSlug = searchParams.get("studio");
  const brand = usePublicAuthBrand(studioSlug);

  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!email.trim()) {
        setError(copy.emptyEmail);
        return;
      }
      setBusy(true);
      try {
        await forgotPasswordRequest(email.trim(), studioSlug ?? undefined);
        setSent(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          // Recovery switched off for this environment — identical for every address.
          setError(copy.unavailable);
        } else if (err instanceof ApiError && err.status === 429) {
          setError(copy.tooMany);
        } else if (err instanceof ApiError && err.status === 400) {
          setError(copy.invalidEmail);
        } else {
          setError(copy.network);
        }
      } finally {
        setBusy(false);
      }
    },
    [email, studioSlug, copy],
  );

  if (sent) {
    return (
      <PublicAuthShell brand={brand}>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{copy.sentTitle}</h1>
        <div className="mt-4 space-y-3">
          <PublicAuthNotice tone="success">{copy.sentBody}</PublicAuthNotice>
          <p className="text-sm text-zinc-600">{copy.sentHint}</p>
        </div>
      </PublicAuthShell>
    );
  }

  return (
    <PublicAuthShell brand={brand}>
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{copy.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">
        {copy.subtitle(brand.displayName ?? "tu estudio")}
      </p>

      <form onSubmit={(e) => void onSubmit(e)} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className={publicAuthLabel}>
            {copy.emailLabel}
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            className={publicAuthInput}
            placeholder={copy.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        {error ? <PublicAuthNotice tone="error">{error}</PublicAuthNotice> : null}

        <PublicAuthButton brand={brand} disabled={busy}>
          {busy ? copy.submitting : copy.submit}
        </PublicAuthButton>
      </form>
    </PublicAuthShell>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-zinc-50">
          <p className="text-sm text-zinc-500">…</p>
        </main>
      }
    >
      <ForgotPasswordForm />
    </Suspense>
  );
}
