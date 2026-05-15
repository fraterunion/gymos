"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CopyFieldRow } from "@/components/CopyFieldRow";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchStudioSettings,
  updateGeneralSettings,
  updateMobileConfig,
  type StudioSettingsDto,
} from "@/lib/api/settings";

const INPUT =
  "w-full rounded-xl border border-zinc-700/90 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30";

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-800/90 bg-zinc-900/35 p-6 shadow-sm backdrop-blur-sm">
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-50">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-zinc-500">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-zinc-300">
      <span
        className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
          ok ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/35" : "bg-zinc-800 text-zinc-500"
        }`}
        aria-hidden
      >
        {ok ? "✓" : ""}
      </span>
      <span>{label}</span>
    </li>
  );
}

function applyFormsFromDto(res: StudioSettingsDto) {
  const m = res.mobile ?? {
    appDisplayName: null,
    appScheme: null,
    expoSlug: null,
    iosBundleIdentifier: null,
    androidPackage: null,
  };
  return {
    mobile: {
      appDisplayName: m.appDisplayName ?? "",
      appScheme: m.appScheme ?? "",
      expoSlug: m.expoSlug ?? "",
      iosBundleIdentifier: m.iosBundleIdentifier ?? "",
      androidPackage: m.androidPackage ?? "",
    },
    legal: {
      privacyUrl: res.general.privacyUrl ?? "",
      termsUrl: res.general.termsUrl ?? "",
    },
  };
}

type SaveKey = "mobile" | "legal";

export default function PlatformConsolePage() {
  const { selectedStudioId, selected, loading: studiosLoading, error: studiosError } = useDeskStudio();
  const canManage = selected?.role === "OWNER" || selected?.role === "ADMIN";

  const [data, setData] = useState<StudioSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<SaveKey | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [buildNote, setBuildNote] = useState<string | null>(null);

  const [mobile, setMobile] = useState({
    appDisplayName: "",
    appScheme: "",
    expoSlug: "",
    iosBundleIdentifier: "",
    androidPackage: "",
  });
  const [legal, setLegal] = useState({ privacyUrl: "", termsUrl: "" });

  const applyServerData = useCallback((res: StudioSettingsDto) => {
    setData(res);
    const f = applyFormsFromDto(res);
    setMobile(f.mobile);
    setLegal(f.legal);
  }, []);

  const reload = useCallback(async () => {
    if (!selectedStudioId || !canManage) {
      setData(null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchStudioSettings(selectedStudioId);
      if (!res.mobile) {
        setLoadError(
          "Mobile configuration was not returned for this session. Confirm your account is a platform operator and matches API allowlist (email domain / PLATFORM_EXTRA_OPERATOR_EMAILS).",
        );
        setData(null);
        return;
      }
      applyServerData(res);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.status === 403
            ? "Forbidden — you need owner or admin membership on this studio, and platform email access for mobile fields."
            : e.message
          : "Could not load tenant.";
      setLoadError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, canManage, applyServerData]);

  useEffect(() => {
    queueMicrotask(() => {
      void reload();
    });
  }, [reload]);

  const mobileDraftReady = useMemo(() => {
    const fields = [
      mobile.appDisplayName,
      mobile.appScheme,
      mobile.expoSlug,
      mobile.iosBundleIdentifier,
      mobile.androidPackage,
    ].map((x) => x.trim());
    return fields.every((x) => x.length > 0);
  }, [mobile]);

  const checklist = useMemo(() => {
    if (!data) return null;
    const logoOk = !!(data.branding.effectiveLogoUrl?.trim() || data.branding.logoUrl?.trim());
    const nameOk = !!(data.mobile?.appDisplayName?.trim());
    const colorsOk = !!(
      (data.branding.primaryColor ?? data.branding.legacyBrandPrimaryColor)?.trim() &&
      (data.branding.accentColor ?? data.branding.legacyBrandSecondaryColor)?.trim()
    );
    const bundleOk = !!(
      data.mobile?.iosBundleIdentifier?.trim() && data.mobile?.androidPackage?.trim()
    );
    const privacyOk = !!(data.general.privacyUrl?.trim());
    const termsOk = !!(data.general.termsUrl?.trim());
    return { logoOk, nameOk, colorsOk, bundleOk, privacyOk, termsOk };
  }, [data]);

  async function runSave(key: SaveKey, fn: () => Promise<StudioSettingsDto>) {
    if (!selectedStudioId) return;
    setSectionError(null);
    setSaving(key);
    try {
      const next = await fn();
      if (!next.mobile) {
        setSectionError("Save succeeded but mobile payload was missing — check platform operator configuration.");
        return;
      }
      applyServerData(next);
      setFlash("Saved");
      window.setTimeout(() => setFlash(null), 2200);
    } catch (e) {
      setSectionError(e instanceof ApiError ? e.message : "Save failed.");
    } finally {
      setSaving(null);
    }
  }

  const onSaveMobile = () => {
    if (!selectedStudioId) return;
    void runSave("mobile", () =>
      updateMobileConfig(selectedStudioId, {
        appDisplayName: mobile.appDisplayName.trim() || null,
        appScheme: mobile.appScheme.trim() || null,
        expoSlug: mobile.expoSlug.trim() || null,
        iosBundleIdentifier: mobile.iosBundleIdentifier.trim() || null,
        androidPackage: mobile.androidPackage.trim() || null,
      }),
    );
  };

  const onSaveLegal = () => {
    if (!selectedStudioId) return;
    void runSave("legal", () =>
      updateGeneralSettings(selectedStudioId, {
        privacyUrl: legal.privacyUrl.trim() || null,
        termsUrl: legal.termsUrl.trim() || null,
      }),
    );
  };

  if (studiosLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-zinc-500">Loading studios…</p>
      </div>
    );
  }

  if (studiosError) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-200">{studiosError}</div>
    );
  }

  if (!canManage) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <h2 className="text-lg font-semibold text-zinc-100">Owner or admin required</h2>
        <p className="mt-2 text-sm text-zinc-500">
          Platform tools still use studio membership. Ask for ADMIN on this tenant, or switch studio in the header.
        </p>
      </div>
    );
  }

  if (!selectedStudioId) {
    return <p className="text-sm text-zinc-500">Select a tenant in the header.</p>;
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-zinc-800" />
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-900/40" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="rounded-xl border border-amber-900/40 bg-amber-950/15 p-4 text-sm text-amber-100">{loadError}</div>
    );
  }

  return (
    <div className="space-y-8 pb-16">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">Tenant mobile &amp; store readiness</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Bundle identifiers and Expo metadata for white-label builds. Store URLs and legal links are required for
            app review.
          </p>
        </div>
        {flash ? (
          <span className="text-xs font-medium text-emerald-400" role="status">
            {flash}
          </span>
        ) : (
          <span className="text-xs text-zinc-600">Updated {new Date(data.updatedAt).toLocaleString()}</span>
        )}
      </header>

      <div className="rounded-xl border border-amber-900/35 bg-amber-950/10 px-4 py-3 text-sm text-amber-100/95">
        <strong className="font-semibold text-amber-200">Production warning.</strong> Changing the iOS bundle identifier
        or Android application ID after a store release usually requires a new listing. Coordinate with engineering
        before editing live tenants.
      </div>

      {sectionError ? (
        <div className="rounded-xl border border-red-900/40 bg-red-950/15 px-4 py-3 text-sm text-red-200">
          {sectionError}
        </div>
      ) : null}

      <SectionCard
        title="Mobile app configuration"
        subtitle="Native identifiers and Expo project slug. Copied values reflect the form below."
      >
        <div className="mb-6 grid gap-2 sm:grid-cols-2">
          <CopyFieldRow label="App display name" value={mobile.appDisplayName || null} />
          <CopyFieldRow label="App scheme" value={mobile.appScheme || null} />
          <CopyFieldRow label="Expo slug" value={mobile.expoSlug || null} />
          <CopyFieldRow label="iOS bundle identifier" value={mobile.iosBundleIdentifier || null} />
          <CopyFieldRow label="Android package" value={mobile.androidPackage || null} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">App display name</span>
            <input
              className={INPUT}
              value={mobile.appDisplayName}
              onChange={(e) => setMobile((m) => ({ ...m, appDisplayName: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">App scheme</span>
            <input className={INPUT} value={mobile.appScheme} onChange={(e) => setMobile((m) => ({ ...m, appScheme: e.target.value }))} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Expo slug</span>
            <input className={INPUT} value={mobile.expoSlug} onChange={(e) => setMobile((m) => ({ ...m, expoSlug: e.target.value }))} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">iOS bundle identifier</span>
            <input
              className={INPUT}
              value={mobile.iosBundleIdentifier}
              onChange={(e) => setMobile((m) => ({ ...m, iosBundleIdentifier: e.target.value }))}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Android package</span>
            <input
              className={INPUT}
              value={mobile.androidPackage}
              onChange={(e) => setMobile((m) => ({ ...m, androidPackage: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving === "mobile"}
            onClick={onSaveMobile}
            className="rounded-xl bg-amber-500/90 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-amber-400 disabled:cursor-wait disabled:opacity-60"
          >
            {saving === "mobile" ? "Saving…" : "Save mobile config"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="White-label build" subtitle="Pipeline integration is not enabled in this environment.">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-4">
          <div>
            <p className="text-sm font-medium text-zinc-100">Release profile</p>
            <p className="mt-1 text-xs text-zinc-500">Mobile identifiers complete: {mobileDraftReady ? "yes" : "no"}</p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              mobileDraftReady
                ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                : "bg-amber-500/10 text-amber-200 ring-1 ring-amber-500/25"
            }`}
          >
            {mobileDraftReady ? "Ready" : "Incomplete"}
          </span>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-2">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Build status</dt>
            <dd className="mt-1 text-sm text-zinc-300">Not connected</dd>
          </div>
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-2">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Last build</dt>
            <dd className="mt-1 text-sm text-zinc-300">—</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setBuildNote("Build queue is not wired — UI only.");
              window.setTimeout(() => setBuildNote(null), 4000);
            }}
            className="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white"
          >
            Generate build
          </button>
          {buildNote ? <span className="text-xs text-zinc-500">{buildNote}</span> : null}
        </div>
      </SectionCard>

      <SectionCard title="App Store listing — legal URLs" subtitle="Required for review; stored on the studio record.">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Privacy policy URL</span>
            <input
              className={INPUT}
              placeholder="https://"
              value={legal.privacyUrl}
              onChange={(e) => setLegal((l) => ({ ...l, privacyUrl: e.target.value }))}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Terms of service URL</span>
            <input
              className={INPUT}
              placeholder="https://"
              value={legal.termsUrl}
              onChange={(e) => setLegal((l) => ({ ...l, termsUrl: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving === "legal"}
            onClick={onSaveLegal}
            className="rounded-xl border border-zinc-600 px-4 py-2.5 text-sm font-semibold text-zinc-100 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
          >
            {saving === "legal" ? "Saving…" : "Save legal URLs"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Store listing readiness" subtitle="Checklist against the current tenant record (not live store API).">
        {checklist ? (
          <ul className="space-y-2">
            <CheckRow ok={checklist.logoOk} label="Logo configured (desk branding)" />
            <CheckRow ok={checklist.nameOk} label="App display name" />
            <CheckRow ok={checklist.colorsOk} label="Primary & accent colors" />
            <CheckRow ok={checklist.bundleOk} label="iOS bundle ID & Android package" />
            <CheckRow ok={checklist.privacyOk} label="Privacy policy URL" />
            <CheckRow ok={checklist.termsOk} label="Terms of service URL" />
          </ul>
        ) : null}
        <p className="mt-4 text-xs text-zinc-600">
          App Store / Play Console assets and screenshots are managed outside GymOS.
        </p>
      </SectionCard>
    </div>
  );
}
