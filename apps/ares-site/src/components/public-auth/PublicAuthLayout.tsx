'use client';

import { useEffect, useRef, useState } from 'react';

import {
  fetchPublicStudioBranding,
  isValidStudioSlug,
  safeBrandColor,
} from '@/lib/recoveryApi';

/**
 * Member-facing shell for the recovery pages.
 *
 * The page deliberately carries no logo of its own: this is the studio's own public site,
 * whose header already shows the canonical brand mark directly above this card. Repeating
 * it here would duplicate the lockup and hardcode an asset path into the recovery flow.
 * Studio branding fetched from the public endpoint supplies the accent colour, display
 * name and support contact, so a second white-label deployment needs no change here.
 */

export type RecoveryBrand = {
  displayName: string | null;
  accentColor: string | null;
  supportEmail: string | null;
};

export function useRecoveryBrand(slug: string | null): RecoveryBrand {
  const [brand, setBrand] = useState<RecoveryBrand>({
    displayName: null,
    accentColor: null,
    supportEmail: null,
  });
  // No abort-on-cleanup: the reset page rewrites its own URL to strip the one-time token,
  // which re-runs effects; a cleanup-based cancel would silently drop the response.
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (!isValidStudioSlug(slug)) return;
    if (requested.current === slug) return;
    requested.current = slug;
    void (async () => {
      try {
        const b = await fetchPublicStudioBranding(slug);
        setBrand({
          displayName: b.appName?.trim() || b.name?.trim() || null,
          accentColor: safeBrandColor(b.brandPrimaryColor),
          supportEmail: b.supportEmail?.trim() || null,
        });
      } catch {
        // Branding is decoration: a failed lookup must never block password recovery.
      }
    })();
  }, [slug]);

  return brand;
}

export function PublicAuthLayout({
  brand,
  title,
  subtitle,
  children,
  footer,
}: {
  brand: RecoveryBrand;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">{title}</h1>
        {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}

        {children}
      </div>

      <div className="auth-foot">
        {footer}
        {brand.supportEmail ? (
          <a className="auth-support" href={`mailto:${brand.supportEmail}`}>
            {brand.supportEmail}
          </a>
        ) : null}
      </div>
    </main>
  );
}

export function AuthNotice({
  tone,
  children,
}: {
  tone: 'error' | 'success';
  children: React.ReactNode;
}) {
  return <p className={tone === 'error' ? 'auth-notice auth-notice-error' : 'auth-notice auth-notice-success'}>{children}</p>;
}

export function AuthField({
  id,
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  autoComplete,
  inputMode,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: 'email' | 'text';
}) {
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="auth-input"
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function AuthButton({
  brand,
  busy,
  children,
  type = 'submit',
  onClick,
}: {
  brand: RecoveryBrand;
  busy?: boolean;
  children: React.ReactNode;
  type?: 'submit' | 'button';
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      className="auth-button"
      disabled={busy}
      onClick={onClick}
      style={brand.accentColor ? { borderColor: brand.accentColor } : undefined}
    >
      {children}
    </button>
  );
}
