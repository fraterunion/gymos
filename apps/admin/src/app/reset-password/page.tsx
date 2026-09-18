"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

import {
  PublicAuthButton,
  PublicAuthNotice,
  PublicAuthShell,
  publicAuthInput,
  publicAuthLabel,
  usePublicAuthBrand,
} from "@/components/public-auth/PublicAuthShell";
import { resetPasswordRequest } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/errors";
import {
  DEFAULT_PUBLIC_AUTH_LOCALE,
  PUBLIC_MIN_PASSWORD_LENGTH,
  RESET_COPY,
} from "@/lib/publicAuthCopy";

/**
 * Public reset page — the surface the emailed link opens.
 *
 * Audience is the member, not staff: no session is required, no admin chrome is shown, and
 * the copy is in the same language as the email. The token in the query string IS the
 * credential, so it is read once into memory and then stripped from the address bar; it is
 * never logged, never stored, and never sent anywhere except the reset request itself.
 *
 * The API answers every bad-token case — unknown, expired, already used, superseded — with
 * one identical message, and this page shows exactly that. It deliberately does NOT claim
 * to tell expired from consumed, because the server does not reveal which it was; the
 * user's next step ("request a new link") is the same either way.
 */

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const copy = RESET_COPY[DEFAULT_PUBLIC_AUTH_LOCALE];
  const brand = usePublicAuthBrand(searchParams.get("studio"));

  // Captured once at render time: the effect below rewrites the URL to strip the token, so
  // reading it from searchParams later would come back empty.
  const [linkToken] = useState(() => searchParams.get("token") ?? "");
  const [manualToken, setManualToken] = useState("");
  const token = linkToken || manualToken;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!linkToken) return;
    // Keep the one-time credential out of the address bar, browser history and any Referer
    // header sent by later requests. It already lives in component state.
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [linkToken]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!token.trim()) {
        setError(copy.missingToken);
        return;
      }
      if (password.length < PUBLIC_MIN_PASSWORD_LENGTH) {
        setError(copy.tooShort(PUBLIC_MIN_PASSWORD_LENGTH));
        return;
      }
      if (password !== confirm) {
        setError(copy.mismatch);
        return;
      }
      setBusy(true);
      try {
        await resetPasswordRequest(token.trim(), password);
        setDone(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          setError(copy.unavailable);
        } else if (err instanceof ApiError && err.status === 400) {
          // Server-supplied and already generic for every invalid-token case.
          setError(err.message);
        } else if (err instanceof ApiError && err.status === 429) {
          setError(copy.tooMany);
        } else {
          setError(copy.network);
        }
      } finally {
        setBusy(false);
      }
    },
    [token, password, confirm, copy],
  );

  if (done) {
    return (
      <PublicAuthShell brand={brand}>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{copy.successTitle}</h1>
        <div className="mt-4 space-y-3">
          <PublicAuthNotice tone="success">{copy.successBody}</PublicAuthNotice>
          <p className="text-sm text-zinc-600">
            {brand.displayName ? copy.successNextApp : copy.successNextWeb}
          </p>
        </div>
      </PublicAuthShell>
    );
  }

  return (
    <PublicAuthShell brand={brand}>
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{copy.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">{copy.subtitle(PUBLIC_MIN_PASSWORD_LENGTH)}</p>

      <form onSubmit={(e) => void onSubmit(e)} className="mt-6 space-y-4">
        {linkToken ? null : (
          <div>
            <label htmlFor="token" className={publicAuthLabel}>
              {copy.tokenLabel}
            </label>
            <input
              id="token"
              autoComplete="off"
              spellCheck={false}
              className={publicAuthInput}
              placeholder={copy.tokenPlaceholder}
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
            />
          </div>
        )}

        <div>
          <label htmlFor="password" className={publicAuthLabel}>
            {copy.passwordLabel}
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            className={publicAuthInput}
            placeholder={copy.passwordPlaceholder(PUBLIC_MIN_PASSWORD_LENGTH)}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="confirm" className={publicAuthLabel}>
            {copy.confirmLabel}
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            className={publicAuthInput}
            placeholder={copy.confirmPlaceholder}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error ? <PublicAuthNotice tone="error">{error}</PublicAuthNotice> : null}

        <PublicAuthButton brand={brand} disabled={busy}>
          {busy ? copy.submitting : copy.submit}
        </PublicAuthButton>

        <a
          href="/forgot-password"
          className="block text-center text-sm text-zinc-500 underline underline-offset-4"
        >
          {copy.requestNewLink}
        </a>
      </form>
    </PublicAuthShell>
  );
}

/** useSearchParams() opts this prerendered route into client rendering; Next requires the
 *  boundary, and the build fails without it. */
export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-zinc-50">
          <p className="text-sm text-zinc-500">{RESET_COPY[DEFAULT_PUBLIC_AUTH_LOCALE].loading}</p>
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
