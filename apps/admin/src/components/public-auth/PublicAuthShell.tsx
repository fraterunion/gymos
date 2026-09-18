"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import {
  fetchPublicStudioBranding,
  isValidStudioSlug,
  safeBrandColor,
  safeBrandLogo,
} from "@/lib/api/publicBranding";

/**
 * Layout for the logged-out recovery pages. Deliberately NOT the desk shell: no navigation,
 * no studio switcher, no admin chrome — a member arriving from an email must see a simple,
 * legible page that belongs to their gym, on a phone, without signing in.
 *
 * Branding is resolved at runtime from the `studio` hint the reset link carries, so nothing
 * here is tied to one customer; with no hint (or a failed lookup) the page renders a neutral
 * platform style that is still perfectly usable.
 */

export type PublicAuthBrand = {
  displayName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
};

const NEUTRAL_ACCENT = "#18181b";

export function usePublicAuthBrand(slug: string | null): PublicAuthBrand {
  const [brand, setBrand] = useState<PublicAuthBrand>({
    displayName: null,
    logoUrl: null,
    primaryColor: null,
    supportEmail: null,
  });

  // Deliberately NO abort-on-cleanup. The reset page rewrites its own URL to strip the
  // one-time token, which re-runs effects; cancelling on cleanup silently dropped the
  // in-flight response and the page fell back to neutral branding. A ref keyed by slug
  // gives idempotence instead, so a re-render can never lose an answer already on the way.
  const requestedSlug = useRef<string | null>(null);

  useEffect(() => {
    if (!isValidStudioSlug(slug)) return;
    if (requestedSlug.current === slug) return;
    requestedSlug.current = slug;
    void (async () => {
      try {
        const b = await fetchPublicStudioBranding(slug);
        setBrand({
          displayName: b.appName?.trim() || b.name?.trim() || null,
          logoUrl: safeBrandLogo(b.brandLogoUrl),
          primaryColor: safeBrandColor(b.brandPrimaryColor),
          supportEmail: b.supportEmail?.trim() || null,
        });
      } catch {
        // Branding is decoration: a failed lookup must never block password recovery.
      }
    })();
  }, [slug]);

  return brand;
}

export function PublicAuthShell({
  brand,
  children,
}: {
  brand: PublicAuthBrand;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3">
          {brand.logoUrl ? (
            <Image
              src={brand.logoUrl}
              alt={brand.displayName ?? ""}
              width={160}
              height={56}
              unoptimized
              className="h-14 w-auto object-contain"
            />
          ) : brand.displayName ? (
            <span className="text-lg font-semibold tracking-tight text-zinc-900">
              {brand.displayName}
            </span>
          ) : null}
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          {children}
        </div>

        {brand.supportEmail ? (
          <p className="mt-6 text-center text-xs text-zinc-500">
            <a className="underline underline-offset-4" href={`mailto:${brand.supportEmail}`}>
              {brand.supportEmail}
            </a>
          </p>
        ) : null}
      </div>
    </main>
  );
}

export function accentStyle(brand: PublicAuthBrand): React.CSSProperties {
  return { backgroundColor: brand.primaryColor ?? NEUTRAL_ACCENT };
}

export function PublicAuthButton({
  brand,
  disabled,
  type = "submit",
  onClick,
  children,
}: {
  brand: PublicAuthBrand;
  disabled?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={accentStyle(brand)}
      className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function PublicAuthNotice({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  const className =
    tone === "error"
      ? "rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      : "rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900";
  return <p className={className}>{children}</p>;
}

export const publicAuthInput =
  "w-full rounded-xl border border-zinc-300 bg-white px-3 py-3 text-base text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200";

export const publicAuthLabel = "mb-1.5 block text-sm font-medium text-zinc-700";
