'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  AuthButton,
  AuthField,
  AuthNotice,
  PublicAuthLayout,
  useRecoveryBrand,
} from '@/components/public-auth/PublicAuthLayout';
import {
  DEFAULT_PUBLIC_AUTH_LOCALE,
  PUBLIC_MIN_PASSWORD_LENGTH,
  RESET_COPY,
} from '@/lib/publicAuthCopy';
import { RecoveryApiError, resetPasswordRequest } from '@/lib/recoveryApi';

/**
 * Member-facing reset page — the surface the emailed link opens.
 *
 * The token in the query string IS the credential: it is captured once at render, stripped
 * from the address bar, and never stored, logged or sent anywhere except the reset request.
 *
 * The API answers every bad-token case — unknown, expired, already used, superseded — with
 * one identical message, and this page shows exactly that. It deliberately does NOT claim
 * to tell expired from consumed, because the server does not reveal which it was; the
 * user's next step ("request a new link") is the same either way.
 */
function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const copy = RESET_COPY[DEFAULT_PUBLIC_AUTH_LOCALE];
  const brand = useRecoveryBrand(searchParams.get('studio'));

  // Captured at render: the effect below rewrites the URL, so a later read comes back empty.
  const [linkToken] = useState(() => searchParams.get('token') ?? '');
  const [manualToken, setManualToken] = useState('');
  const token = linkToken || manualToken;

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!linkToken) return;
    // Keep the one-time credential out of the address bar, browser history and any Referer
    // header sent by later requests. It already lives in component state.
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
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
        if (err instanceof RecoveryApiError && err.status === 503) {
          setError(copy.unavailable);
        } else if (err instanceof RecoveryApiError && err.status === 400) {
          // Server-supplied and already generic for every invalid-token case.
          setError(err.message);
        } else if (err instanceof RecoveryApiError && err.status === 429) {
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
      <PublicAuthLayout brand={brand} title={copy.successTitle}>
        <div className="auth-form">
          <AuthNotice tone="success">{copy.successBody}</AuthNotice>
          <p className="auth-hint">{copy.successNextApp}</p>
        </div>
      </PublicAuthLayout>
    );
  }

  return (
    <PublicAuthLayout
      brand={brand}
      title={copy.title}
      subtitle={copy.subtitle(PUBLIC_MIN_PASSWORD_LENGTH)}
      footer={
        <a className="auth-link" href="/forgot-password">
          {copy.requestNewLink}
        </a>
      }
    >
      <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
        {linkToken ? null : (
          <AuthField
            id="token"
            label={copy.tokenLabel}
            value={manualToken}
            onChange={setManualToken}
            placeholder={copy.tokenPlaceholder}
            autoComplete="off"
          />
        )}
        <AuthField
          id="password"
          label={copy.passwordLabel}
          type="password"
          autoComplete="new-password"
          placeholder={copy.passwordPlaceholder(PUBLIC_MIN_PASSWORD_LENGTH)}
          value={password}
          onChange={setPassword}
        />
        <AuthField
          id="confirm"
          label={copy.confirmLabel}
          type="password"
          autoComplete="new-password"
          placeholder={copy.confirmPlaceholder}
          value={confirm}
          onChange={setConfirm}
        />
        {error ? <AuthNotice tone="error">{error}</AuthNotice> : null}
        <AuthButton brand={brand} busy={busy}>
          {busy ? copy.submitting : copy.submit}
        </AuthButton>
      </form>
    </PublicAuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="auth-page" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
