'use client';

import { Suspense, useCallback, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  AuthButton,
  AuthField,
  AuthNotice,
  PublicAuthLayout,
  useRecoveryBrand,
} from '@/components/public-auth/PublicAuthLayout';
import { DEFAULT_PUBLIC_AUTH_LOCALE, FORGOT_COPY } from '@/lib/publicAuthCopy';
import { RecoveryApiError, forgotPasswordRequest } from '@/lib/recoveryApi';

/**
 * Member-facing "forgot password" page on the studio's own domain.
 *
 * The API answers identically whether or not the address has an account, and so does this
 * page: one confirmation state, never a branch on existence.
 */
function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const copy = FORGOT_COPY[DEFAULT_PUBLIC_AUTH_LOCALE];
  const studioSlug = searchParams.get('studio');
  const brand = useRecoveryBrand(studioSlug);

  const [email, setEmail] = useState('');
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
        if (err instanceof RecoveryApiError && err.status === 503) {
          setError(copy.unavailable);
        } else if (err instanceof RecoveryApiError && err.status === 429) {
          setError(copy.tooMany);
        } else if (err instanceof RecoveryApiError && err.status === 400) {
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
      <PublicAuthLayout brand={brand} title={copy.sentTitle}>
        <div className="auth-form">
          <AuthNotice tone="success">{copy.sentBody}</AuthNotice>
          <p className="auth-hint">{copy.sentHint}</p>
        </div>
      </PublicAuthLayout>
    );
  }

  return (
    <PublicAuthLayout
      brand={brand}
      title={copy.title}
      subtitle={copy.subtitle(brand.displayName ?? 'tu estudio')}
    >
      <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
        <AuthField
          id="email"
          label={copy.emailLabel}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder={copy.emailPlaceholder}
          value={email}
          onChange={setEmail}
        />
        {error ? <AuthNotice tone="error">{error}</AuthNotice> : null}
        <AuthButton brand={brand} busy={busy}>
          {busy ? copy.submitting : copy.submit}
        </AuthButton>
      </form>
    </PublicAuthLayout>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<main className="auth-page" />}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
